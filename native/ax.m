// 在进程内直接调 Accessibility API 读鼠标选中的文字。
//
// 为什么必须是原生扩展：AX 调用查的是「发起调用的进程」有没有辅助功能授权，
// 而子进程不继承父进程的授权。所以用 osascript / 独立 helper 都拿不到权限
// （实测 Electron 自己 isTrustedAccessibilityClient=true，但它 spawn 的 osascript
// 调 AX 仍然返回 kAXErrorCannotComplete）。只有编进 Electron 进程内才行。

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <node_api.h>
#import <pthread.h>
#import <unistd.h>

/** 退回路径下轮询焦点元素的次数与间隔：最多等 7 × 150ms = 1.05s */
#define FALLBACK_ATTEMPTS 7
#define FALLBACK_INTERVAL_US (150 * 1000)

// 点菜单栏图标会让本应用变成前台，那一刻再问「谁是前台应用」只能问到自己。
// 所以后台线程订阅 NSWorkspace 的激活通知，一直记着「上一个不是自己的前台应用」。
static pthread_mutex_t gLock = PTHREAD_MUTEX_INITIALIZER;
static pid_t gLastOtherPid = -1;
static bool gWatcherStarted = false;

static pid_t lastOtherPid(void) {
	pthread_mutex_lock(&gLock);
	pid_t pid = gLastOtherPid;
	pthread_mutex_unlock(&gLock);
	return pid;
}

static void startActivationWatcher(void) {
	if (gWatcherStarted) return;
	gWatcherStarted = true;

	NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
	if (front && front.processIdentifier != getpid()) {
		pthread_mutex_lock(&gLock);
		gLastOtherPid = front.processIdentifier;
		pthread_mutex_unlock(&gLock);
	}

	[NSThread detachNewThreadWithBlock:^{
		NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
		[workspace.notificationCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification
		                                         object:nil
		                                          queue:nil
		                                     usingBlock:^(NSNotification *note) {
			NSRunningApplication *app = note.userInfo[NSWorkspaceApplicationKey];
			pid_t pid = app ? app.processIdentifier : -1;
			if (pid > 0 && pid != getpid()) {
				pthread_mutex_lock(&gLock);
				gLastOtherPid = pid;
				pthread_mutex_unlock(&gLock);
			}
		}];
		// 通知要挂在有 run loop 的线程上才会投递
		[NSRunLoop.currentRunLoop run];
	}];
}

static void setString(napi_env env, napi_value obj, const char *key, NSString *value) {
	napi_value js;
	napi_create_string_utf8(env, value ? value.UTF8String : "", NAPI_AUTO_LENGTH, &js);
	napi_set_named_property(env, obj, key, js);
}

static void setInt(napi_env env, napi_value obj, const char *key, int value) {
	napi_value js;
	napi_create_int32(env, value, &js);
	napi_set_named_property(env, obj, key, js);
}

static void setBool(napi_env env, napi_value obj, const char *key, bool value) {
	napi_value js;
	napi_get_boolean(env, value, &js);
	napi_set_named_property(env, obj, key, js);
}

static NSString *stringOf(CFTypeRef ref) {
	return ref ? [NSString stringWithFormat:@"%@", (__bridge id)ref] : @"";
}

static pid_t frontmostPid(void) {
	NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
	return front ? front.processIdentifier : -1;
}

/** 读焦点元素里选中的文字，附带出错时的 AX 错误码和前后台应用信息，便于诊断。 */
static napi_value ReadFocusedSelection(napi_env env, napi_callback_info info) {
	napi_value result;
	napi_create_object(env, &result);

	NSString *text = @"";
	NSString *appName = @"";
	NSString *role = @"";
	AXError appErr = kAXErrorFailure;
	AXError elementErr = -1;
	AXError selectErr = -1;
	pid_t axPid = -1;
	bool usedFallback = false;
	int elementAttempts = 0;

	pid_t self = getpid();
	pid_t front = frontmostPid();
	pid_t lastOther = lastOtherPid();

	// 先走系统级「当前焦点应用」。原生应用（终端、备忘录、预览…）到这一步就够了。
	AXUIElementRef system = AXUIElementCreateSystemWide();
	CFTypeRef appRef = NULL;
	appErr = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute, &appRef);
	CFRelease(system);

	AXUIElementRef app = NULL;
	if (appErr == kAXErrorSuccess && appRef) {
		pid_t pid = -1;
		AXUIElementGetPid((AXUIElementRef)appRef, &pid);
		if (pid == self) {
			// 焦点已经被自己抢走了，这个结果没用
			CFRelease(appRef);
			appRef = NULL;
		} else {
			app = (AXUIElementRef)appRef;
		}
	}

	// 退回：优先用「上一个不是自己的前台应用」，它比当前前台更可靠——
	// 点菜单栏图标会让我们自己变成前台，当前值往往是本应用。
	// 再退一步才用当前前台 pid。
	// 走这条路径的典型场景是 Chromium 系（Chrome / Electron / VS Code）
	// 默认不构建 AX 树，上面的系统级查询会返回 NoValue。
	if (!app) {
		pid_t candidate = (lastOther > 0 && lastOther != self) ? lastOther : (front != self ? front : -1);
		if (candidate > 0) {
			app = AXUIElementCreateApplication(candidate);
			usedFallback = true;
		}
	}

	if (app) {
		AXUIElementGetPid(app, &axPid);

		// 主动让目标应用建树。只有 Chromium 系认这个属性，别的应用会返回错误。
		if (usedFallback) {
			AXUIElementSetAttributeValue(app, CFSTR("AXManualAccessibility"), kCFBooleanTrue);
			AXUIElementSetAttributeValue(app, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
		}

		CFTypeRef titleRef = NULL;
		if (AXUIElementCopyAttributeValue(app, kAXTitleAttribute, &titleRef) == kAXErrorSuccess) {
			appName = stringOf(titleRef);
		}
		if (titleRef) CFRelease(titleRef);
		// 有些应用的 AXTitle 是空的，退回按 pid 问系统要名字
		if (appName.length == 0 && axPid > 0) {
			NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:axPid];
			if (running.localizedName) appName = running.localizedName;
		}

		CFTypeRef elementRef = NULL;

		// 建树是异步的，刚设完就查往往还是空的。只有退回路径才轮询——
		// 原生应用走系统级查询，一次就该有结果，不该白等。
		const int attempts = usedFallback ? FALLBACK_ATTEMPTS : 1;
		while (elementAttempts < attempts) {
			if (elementAttempts > 0) usleep(FALLBACK_INTERVAL_US);
			elementAttempts++;
			elementErr = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, &elementRef);
			if (elementErr == kAXErrorSuccess && elementRef) break;
			elementRef = NULL;
		}

		if (elementErr == kAXErrorSuccess && elementRef) {
			AXUIElementRef element = (AXUIElementRef)elementRef;

			CFTypeRef roleRef = NULL;
			if (AXUIElementCopyAttributeValue(element, kAXRoleAttribute, &roleRef) == kAXErrorSuccess) {
				role = stringOf(roleRef);
			}
			if (roleRef) CFRelease(roleRef);

			CFTypeRef selectedRef = NULL;
			selectErr = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute, &selectedRef);
			if (selectErr == kAXErrorSuccess) text = stringOf(selectedRef);
			if (selectedRef) CFRelease(selectedRef);

			CFRelease(elementRef);
		}
	}
	if (appRef) CFRelease(appRef);
	if (app && usedFallback) CFRelease(app);

	setString(env, result, "text", text);
	setInt(env, result, "appErr", appErr);
	setInt(env, result, "elementErr", elementErr);
	setInt(env, result, "selectErr", selectErr);
	setInt(env, result, "axAppPid", axPid);
	setString(env, result, "axAppName", appName);
	setString(env, result, "axRole", role);
	setInt(env, result, "frontPid", front);
	setString(env, result, "frontName", front > 0
		? ([NSRunningApplication runningApplicationWithProcessIdentifier:front].localizedName ?: @"")
		: @"");
	setInt(env, result, "selfPid", self);
	setBool(env, result, "usedFallback", usedFallback);
	setInt(env, result, "elementAttempts", elementAttempts);
	setInt(env, result, "lastOtherPid", lastOther);

	return result;
}

NAPI_MODULE_INIT() {
	// 加载时就开始盯着前台应用切换，等到点图标那一刻再开始记就晚了
	startActivationWatcher();

	napi_value fn;
	napi_create_function(env, "readFocusedSelection", NAPI_AUTO_LENGTH, ReadFocusedSelection, NULL, &fn);
	napi_set_named_property(env, exports, "readFocusedSelection", fn);
	return exports;
}
