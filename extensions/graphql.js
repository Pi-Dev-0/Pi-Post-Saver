/** @type {Set<(ev: import('./types').GraphqlEvent) => void>} */
const listeners = new Set();

/**
 * @param {(ev: import('./types').GraphqlEvent) => void} cb
 * @returns {() => void}
 */
export function graphqlListener(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * @param {import('./types').GraphqlEvent} ev
 */
function emit(ev) {
  for (const cb of listeners) {
    try {
      cb(ev);
    } catch {
      // ignore listener errors
    }
  }
}

// Use the current page origin so redirects (facebook.com -> www.facebook.com)
// and alternate hosts (web.facebook.com, m.facebook.com) still match.
const GRAPHQL_URL = `${location.origin}/api/graphql/`;

/**
 * Map of API names to their module names and fallback doc IDs.
 * @type {Record<string, { moduleName: string, fallbackDocId: string }>}
 */
const DOC_ID_MODULES = {
  CometPhotoRootContentQuery: {
    moduleName: "CometPhotoRootContentQuery_facebookRelayOperation",
    fallbackDocId: "25407333282216326",
  },
  CometVideoRootMediaViewerQuery: {
    moduleName: "CometVideoRootMediaViewerQuery_facebookRelayOperation",
    fallbackDocId: "25092610667077508",
  },
  StoriesViewerBucketPrefetcherMultiBucketsQuery: {
    moduleName: "StoriesViewerBucketPrefetcherMultiBucketsQuery_facebookRelayOperation",
    fallbackDocId: "9340191609394579",
  },
  ClubsVideoPlayerRootQuery: {
    moduleName: "ClubsVideoPlayerRootQuery_facebookRelayOperation",
    fallbackDocId: "6487824887961234",
  },
  CometReelMediaViewerQuery: {
    moduleName: "CometReelMediaViewerQuery_facebookRelayOperation",
    fallbackDocId: "7185078178184498",
  },
};

/**
 * Default variables for each API. These will be merged with input variables.
 * @type {Record<string, Record<string, unknown>>}
 */
const DEFAULT_VARIABLES = {
  CometPhotoRootContentQuery: {
    feedbackSource: 65,
    feedLocation: "COMET_MEDIA_VIEWER",
    focusCommentID: null,
    isMediaset: true,
    privacySelectorRenderLocation: "COMET_MEDIA_VIEWER",
    renderLocation: "comet_media_viewer",
    shouldShowComments: true,
    scale: 3,
    useDefaultActor: false,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
    __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
    __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
    __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
    __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
  },
  CometVideoRootMediaViewerQuery: {
    feedbackSource: 65,
    feedLocation: "COMET_MEDIA_VIEWER",
    focusCommentID: null,
    isMediaset: true,
    privacySelectorRenderLocation: "COMET_STREAM",
    renderLocation: "permalink",
    scale: 3,
    useDefaultActor: false,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
    __relay_internal__pv__TestPilotShouldIncludeDemoAdUseCaserelayprovider: false,
    __relay_internal__pv__CometUFIShareActionMigrationrelayprovider: true,
    __relay_internal__pv__CometUFICommentAvatarStickerAnimatedImagerelayprovider: false,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
    __relay_internal__pv__CometUFIReactionsEnableShortNamerelayprovider: false,
    __relay_internal__pv__CometImmersivePhotoCanUserDisable3DMotionrelayprovider: false,
  },
  StoriesViewerBucketPrefetcherMultiBucketsQuery: {
    scale: 3,
    blur: 20,
    shouldEnableArmadilloStoryReply: true,
    shouldEnableLiveInStories: true,
    feedbackSource: 65,
    useDefaultActor: false,
    feedLocation: "COMET_MEDIA_VIEWER",
    focusCommentID: null,
    shouldDeferLoad: false,
    isStoriesArchive: false,
    __relay_internal__pv__IsWorkUserrelayprovider: false,
  },
  ClubsVideoPlayerRootQuery: {
    scale: 3,
    useDefaultActor: false,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
  },
  CometReelMediaViewerQuery: {
    scale: 3,
    useDefaultActor: false,
    __relay_internal__pv__GHLShouldChangeSponsoredDataFieldNamerelayprovider: true,
  },
};

/**
 * Get doc_id for an API using Facebook's internal require().
 * @param {string} apiName
 * @returns {string}
 */
function getDocId(apiName) {
  const config = DOC_ID_MODULES[apiName];
  if (!config) throw new Error(`Unknown API: ${apiName}`);
  // @ts-ignore - Facebook's global require
  return require(config.moduleName) ?? config.fallbackDocId;
}

/**
 * Extract common request parameters from the page.
 * @returns {{ params: URLSearchParams, lsd: string }}
 */
function extractPageContext() {
  const params = new URLSearchParams();
  let lsd = "";

  try {
    // Get user ID from cookie
    const userMatch = document.cookie.match(/c_user=(\d+)/);
    if (userMatch) {
      params.set("__user", userMatch[1]);
      params.set("av", userMatch[1]);
    }

    // Get fb_dtsg from DTSGInitData module (preferred) or hidden input
    try {
      // @ts-ignore
      const dtsgData = require("DTSGInitData");
      if (dtsgData?.token) {
        params.set("fb_dtsg", dtsgData.token);
      }
    } catch {
      const dtsgInput = document.querySelector('input[name="fb_dtsg"]');
      if (dtsgInput instanceof HTMLInputElement && dtsgInput.value) {
        params.set("fb_dtsg", dtsgInput.value);
      }
    }

    // Get lsd from LSD module or hidden input
    try {
      // @ts-ignore
      const lsdData = require("LSD");
      if (lsdData?.token) {
        lsd = lsdData.token;
        params.set("lsd", lsd);
      }
    } catch {
      const lsdInput = document.querySelector('input[name="lsd"]');
      if (lsdInput instanceof HTMLInputElement && lsdInput.value) {
        lsd = lsdInput.value;
        params.set("lsd", lsd);
      }
    }

    // Get jazoest - it's a checksum derived from fb_dtsg
    // Format: "2" + sum of char codes of fb_dtsg
    const fbDtsg = params.get("fb_dtsg");
    if (fbDtsg) {
      let sum = 0;
      for (let i = 0; i < fbDtsg.length; i++) {
        sum += fbDtsg.charCodeAt(i);
      }
      params.set("jazoest", "2" + sum);
    }

    // Get SiteData for revision and other context
    try {
      // @ts-ignore
      const siteData = require("SiteData");
      if (siteData?.server_revision) {
        params.set("__rev", String(siteData.server_revision));
        params.set("__spin_r", String(siteData.server_revision));
      }
      if (siteData?.hsi) {
        params.set("__hsi", siteData.hsi);
      }
      if (siteData?.haste_session) {
        params.set("__hs", siteData.haste_session);
      }
    } catch {
      // fallback: skip these optional params
    }

    // Get SprinkleConfig for __s
    try {
      // @ts-ignore
      const sprinkle = require("SprinkleConfig");
      if (sprinkle?.param_name && sprinkle?.version) {
        params.set("__s", sprinkle.version);
      }
    } catch {
      // skip if not available
    }

    // Get CurrentRoute for __crn
    try {
      // @ts-ignore
      const route = require("CurrentCometRouteStateStore");
      const currentRoute = route?.getState?.()?.currentRoute?.name;
      if (currentRoute) {
        params.set("__crn", currentRoute);
      }
    } catch {
      // skip if not available
    }

    // Static/common params
    params.set("__a", "1");
    params.set("__aaid", "0");
    params.set("dpr", String(window.devicePixelRatio || 1));
    params.set("__ccg", "EXCELLENT");
    params.set("__comet_req", "15");
    params.set("__spin_b", "trunk");
    params.set("__spin_t", String(Math.floor(Date.now() / 1000)));
    params.set("fb_api_caller_class", "RelayModern");
    params.set("server_timestamps", "true");
  } catch {
    // ignore extraction errors
  }

  return { params, lsd };
}

/** @type {WeakMap<XMLHttpRequest, string>} */
const xhrUrl = new WeakMap();
/** @type {WeakMap<XMLHttpRequest, boolean>} */
const xhrIsTarget = new WeakMap();
/** @type {WeakMap<XMLHttpRequest, Record<string, string>>} */
const xhrHeaders = new WeakMap();
/** @type {WeakMap<XMLHttpRequest, Record<string, string>>} */
const xhrPayload = new WeakMap();

/**
 * Parse NDJSON response text into array of objects.
 * @param {string} text
 * @returns {Record<string, unknown>[]}
 */
function parseNdjson(text) {
  // Strip common anti-JSON prefixes.
  if (text.startsWith("for (;;);")) text = text.slice("for (;;);".length);
  if (text.startsWith(")]}'")) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  }

  /** @type {Record<string, unknown>[]} */
  const result = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      result.push(JSON.parse(trimmed));
    } catch {
      // skip invalid JSON lines
    }
  }
  return result;
}

const originalXhrOpen = XMLHttpRequest.prototype.open;
const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
const originalXhrSend = XMLHttpRequest.prototype.send;

/**
 * @param {string} method
 * @param {string | URL} url
 * @param {boolean} [async]
 * @param {string | null} [username]
 * @param {string | null} [password]
 */
XMLHttpRequest.prototype.open = function patchedOpen(
  method,
  url,
  async = true,
  username,
  password,
) {
  const u = typeof url === "string" ? url : url.href;
  const isFacebookGraphql = u.includes("/api/graphql");
  const isInstagramApi =
    u.includes("/graphql/query") ||
    u.includes("/api/v1/") ||
    u.includes("i.instagram.com/api/");

  const isPost = method.toUpperCase() === "POST";
  const isGet = method.toUpperCase() === "GET";

  if ((isFacebookGraphql && isPost) || (isInstagramApi && (isPost || isGet))) {
    xhrUrl.set(this, u);
    xhrIsTarget.set(this, true);
    xhrHeaders.set(this, {});

    this.addEventListener("load", () => {
      if (!xhrIsTarget.get(this)) return;
      if (typeof this.responseText !== "string") return;

      /** @type {Record<string, string>} */
      const responseHeaders = {};
      for (const line of this.getAllResponseHeaders().trim().split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx > 0) {
          responseHeaders[line.slice(0, idx).toLowerCase()] = line
            .slice(idx + 1)
            .trim();
        }
      }

      let responseBody = [];
      try {
        if (isFacebookGraphql) {
          responseBody = parseNdjson(this.responseText);
        } else {
          const contentType = responseHeaders["content-type"] || "";
          const text = this.responseText.trim();
          if (
            contentType.includes("json") ||
            text.startsWith("{") ||
            text.startsWith("[")
          ) {
            const parsed = JSON.parse(text);
            responseBody = Array.isArray(parsed) ? parsed : [parsed];
          }
        }
      } catch (e) {
        // Not JSON or parse error, skip
        return;
      }

      if (responseBody.length === 0) return;

      emit({
        url: xhrUrl.get(this) || "",
        requestHeaders: xhrHeaders.get(this) || {},
        responseHeaders,
        requestPayload: xhrPayload.get(this) || {},
        responseBody,
        status: this.status,
      });
    });
  }

  return originalXhrOpen.call(this, method, url, async, username, password);
};

/**
 * @param {string} name
 * @param {string} value
 */
XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
  name,
  value,
) {
  const headers = xhrHeaders.get(this);
  if (headers) {
    headers[name.toLowerCase()] = value;
  }
  return originalXhrSetRequestHeader.call(this, name, value);
};

/**
 * @param {Document | XMLHttpRequestBodyInit | null} body
 */
XMLHttpRequest.prototype.send = function patchedSend(body) {
  if (xhrIsTarget.get(this)) {
    /** @type {string | undefined} */
    let bodyText;
    if (typeof body === "string") {
      bodyText = body;
    } else if (body instanceof URLSearchParams) {
      bodyText = body.toString();
    } else if (body instanceof FormData) {
      const parts = [];
      for (const [k, v] of body.entries()) {
        parts.push(
          `${encodeURIComponent(String(k))}=${encodeURIComponent(String(v))}`,
        );
      }
      bodyText = parts.join("&");
    }

    if (bodyText) {
      const params = new URLSearchParams(bodyText);
      /** @type {Record<string, string>} */
      const payload = {};
      for (const [k, v] of params.entries()) {
        payload[k] = v;
      }
      xhrPayload.set(this, payload);
    }
  }
  return originalXhrSend.call(this, body);
};

// Patch fetch to intercept GraphQL responses (needed for Reels and newer APIs)
const originalFetch = window.fetch;
window.fetch = async function patchedFetch(input, init) {
  const promise = originalFetch(input, init);

  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  const isFacebookGraphql = url.includes("/api/graphql");
  const isInstagramApi =
    url.includes("/graphql/query") ||
    url.includes("/api/v1/") ||
    url.includes("i.instagram.com/api/");

  if (isFacebookGraphql || isInstagramApi) {
    // Clone the response to read its body without consuming the original
    promise
      .then(async (res) => {
        try {
          const clone = res.clone();
          const text = await clone.text();

          // Extract headers from init if available (approximation)
          const requestHeaders = {};
          if (init && init.headers) {
            if (init.headers instanceof Headers) {
              init.headers.forEach(
                (v, k) => (requestHeaders[k.toLowerCase()] = v),
              );
            } else {
              Object.entries(init.headers).forEach(
                ([k, v]) => (requestHeaders[k.toLowerCase()] = v),
              );
            }
          }

          // Parse payload
          let requestPayload = {};
          if (init && init.body) {
            try {
              const params = new URLSearchParams(String(init.body));
              for (const [k, v] of params.entries()) {
                requestPayload[k] = v;
              }
            } catch {
              /* ignore */
            }
          }

          let responseBody = [];
          try {
            if (isFacebookGraphql) {
              responseBody = parseNdjson(text);
            } else {
              const contentType = res.headers.get("content-type") || "";
              const trimmed = text.trim();
              if (
                contentType.includes("json") ||
                trimmed.startsWith("{") ||
                trimmed.startsWith("[")
              ) {
                const parsed = JSON.parse(trimmed);
                responseBody = Array.isArray(parsed) ? parsed : [parsed];
              }
            }
          } catch (e) {
            // Not JSON or parse error, skip
            return;
          }

          if (responseBody.length === 0) return;

          emit({
            url: url,
            requestHeaders: requestHeaders,
            responseHeaders: {}, // Fetch Headers are harder to sync synchronously
            requestPayload: requestPayload,
            responseBody,
            status: res.status,
          });
        } catch (err) {
          // ignore intercept errors
        }
      })
      .catch(() => {});
  }

  return promise;
};

/**
 * Send a GraphQL request using doc_id from Facebook's module system.
 * @param {{ apiName: string, variables: Record<string, unknown> }} input
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function sendGraphqlRequest(input) {
  const docId = getDocId(input.apiName);
  const { params, lsd } = extractPageContext();

  // Merge default variables with input variables (input takes precedence)
  const defaultVars = DEFAULT_VARIABLES[input.apiName] || {};
  const variables = { ...defaultVars, ...input.variables };

  params.set("fb_api_req_friendly_name", input.apiName);
  params.set("doc_id", docId);
  params.set("variables", JSON.stringify(variables));

  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (lsd) headers["x-fb-lsd"] = lsd;
  headers["x-fb-friendly-name"] = input.apiName;

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    credentials: "include",
    headers,
    body: params.toString(),
  });

  const text = await res.text();
  return parseNdjson(text);
}
