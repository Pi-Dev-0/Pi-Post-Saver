import { graphqlListener, sendGraphqlRequest } from "./graphql.js";

/**
 * @typedef {import('./types').Story} Story
 * @typedef {import('./types').StoryPost} StoryPost
 * @typedef {import('./types').StoryVideo} StoryVideo
 * @typedef {import('./types').StoryWatch} StoryWatch
 * @typedef {import('./types').Media} Media
 * @typedef {import('./types').MediaId} MediaId
 * @typedef {import('./types').MediaVideo} MediaVideo
 * @typedef {import('./types').MediaWatch} MediaWatch
 * @typedef {import('./types').MediaPhoto} MediaPhoto
 * @typedef {import('./types').MediaPhotoUrl} MediaPhotoUrl
 * @typedef {import('./types').User} User
 * @typedef {import('./types').Group} Group
 * @typedef {import('./types').StoryFile} StoryFile
 */

const PHOTO_ROOT_QUERY = "CometPhotoRootContentQuery";
const VIDEO_ROOT_QUERY = "CometVideoRootMediaViewerQuery";

/** @type {Map<string, number>} */
const storyCreateTimeCache = new Map();

/** @type {Map<string, Group>} */
const storyGroupCache = new Map();

/** @type {Map<string, string>} */
const videoUrlCache = new Map();

/** @type {Map<string, Story>} */
const globalStoriesCache = new Map();

/**
 * Check if an object is a MediaPhoto.
 * @param {unknown} obj
 * @returns {obj is MediaPhoto}
 */
function isMediaPhoto(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.__typename !== "Photo") return false;
  if (typeof o.id !== "string" || !o.id) return false;
  return true;
}

/**
 * Check if an object is a MediaVideo (has videoDeliveryResponseFragment or video_grid_renderer).
 * @param {unknown} obj
 * @returns {obj is MediaVideo}
 */
function isMediaVideo(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.__typename !== "Video") return false;
  // MediaVideo has videoDeliveryResponseFragment or video_grid_renderer
  return "videoDeliveryResponseFragment" in o || "video_grid_renderer" in o;
}

/**
 * Check if an object is a MediaWatch (Video with url but no videoDeliveryResponseFragment).
 * @param {unknown} obj
 * @returns {obj is MediaWatch}
 */
function isMediaWatch(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.__typename !== "Video") return false;
  // MediaWatch has url but no videoDeliveryResponseFragment or video_grid_renderer
  return (
    typeof o.url === "string" &&
    !("videoDeliveryResponseFragment" in o) &&
    !("video_grid_renderer" in o)
  );
}

/**
 * Get the download URL and extension for a media item.
 * @param {Media} media
 * @returns {{ url: string, ext: string } | undefined}
 */
function getDownloadUrl(media) {
  const m = /** @type {any} */ (media);

  // Instagram Post/Reel Video
  if (m.video_url) {
    return { url: m.video_url, ext: "mp4" };
  }

  if (
    m.video_versions &&
    Array.isArray(m.video_versions) &&
    m.video_versions.length > 0
  ) {
    const best = m.video_versions.sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
    return { url: best.url, ext: "mp4" };
  }

  // Instagram Image
  if (m.display_url) {
    const url = m.display_url;
    let ext = "jpg";
    if (url.includes(".png") || url.includes("format=png")) ext = "png";
    return { url, ext };
  }

  if (
    m.image_versions2?.candidates &&
    Array.isArray(m.image_versions2.candidates)
  ) {
    const best = m.image_versions2.candidates.sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0];
    return { url: best.url, ext: "jpg" };
  }

  if (isMediaPhoto(media)) {
    // Pick the best image by comparing dimensions (width * height)
    /** @type {MediaPhotoUrl | undefined} */
    let best;
    for (const img of [media.image, media.viewer_image, media.photo_image]) {
      if (!img?.uri) continue;
      const size = img.width * img.height;
      if (!best || size > best.width * best.height) {
        best = img;
      }
    }
    if (!best) return undefined;

    const url = best.uri;
    let ext = "jpg";
    try {
      if (/\.png(\?|$)/i.test(url)) ext = "png";
      else {
        const u = new URL(url);
        const fmt = u.searchParams.get("format");
        if (fmt && /^png$/i.test(fmt)) ext = "png";
      }
    } catch {
      if (/\.png(\?|$)/i.test(url)) ext = "png";
    }
    return { url, ext };
  }

  if (isMediaVideo(media)) {
    // If it's a direct Video object with playable_url
    if (media.playable_url) {
      return { url: media.playable_url, ext: "mp4" };
    }

    const list =
      media?.videoDeliveryResponseFragment?.videoDeliveryResponseResult
        ?.progressive_urls ??
      media?.video_grid_renderer?.video?.videoDeliveryResponseFragment
        ?.videoDeliveryResponseResult?.progressive_urls;

    if (Array.isArray(list) && list.length > 0) {
      const hd = list.find(
        (x) => x?.metadata?.quality === "HD" && x?.progressive_url,
      );
      if (hd?.progressive_url) return { url: hd.progressive_url, ext: "mp4" };

      const first = list.find((x) => x?.progressive_url);
      if (first?.progressive_url)
        return { url: first.progressive_url, ext: "mp4" };
    }
    return undefined;
  }

  if (isMediaWatch(media)) {
    return { url: media.url, ext: "mp4" };
  }

  return undefined;
}

/**
 * Get the number of attachments in a story.
 * @param {Story} story
 * @returns {number}
 */
export function getAttachmentCount(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    // Carousel
    if (s.edge_sidecar_to_children?.edges) {
      return s.edge_sidecar_to_children.edges.length;
    }
    return 1;
  }
  if (isStoryPost(story)) {
    const attachment = story.attachments[0]?.styles.attachment;
    if (!attachment) return 0;
    if ("all_subattachments" in attachment)
      return attachment.all_subattachments.count;
    // Check for shorts video (fb_shorts_story with attachments)
    const shortsAttachments = /** @type {any} */ (attachment).style_infos?.[0]
      ?.fb_shorts_story?.attachments;
    if (Array.isArray(shortsAttachments) && shortsAttachments.length > 0)
      return shortsAttachments.length;
    if ("media" in attachment && attachment.media) return 1;
    return 0;
  }
  if (isStoryVideo(story)) {
    return 1;
  }
  if (isStoryWatch(story)) {
    return 1;
  }
  return 0;
}

/**
 * Get the total number of files to download for a story.
 * This includes attachments + index.md + attached_story attachments (if any).
 * @param {Story} story
 * @returns {number}
 */
export function getDownloadCount(story) {
  let count = getAttachmentCount(story) + 1; // +1 for index.md
  if (isStoryPost(story) && story.attached_story) {
    count += getAttachmentCount(story.attached_story);
  }
  return count;
}

/**
 * Check if an object is a valid MediaId.
 * @param {unknown} obj
 * @returns {obj is MediaId}
 */
function isMediaId(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (o.__typename !== "Video" && o.__typename !== "Photo") return false;
  if (typeof o.id !== "string" || !o.id) return false;
  return true;
}

/**
 * Fetch navigation info for a media node.
 * @param {MediaId} currentId
 * @param {string} mediasetToken
 * @returns {Promise<{ currMedia: Media | undefined, nextId: MediaId | undefined }>}
 */
async function fetchMediaNav(currentId, mediasetToken) {
  const apiName =
    currentId.__typename === "Video" ? VIDEO_ROOT_QUERY : PHOTO_ROOT_QUERY;
  const objs = await sendGraphqlRequest({
    apiName,
    variables: {
      nodeID: currentId.id,
      mediasetToken,
    },
  });

  /** @type {Media | undefined} */
  let currMedia;
  /** @type {MediaId | undefined} */
  let nextId;

  for (const obj of objs) {
    /** @type {any} */
    const data = obj.data;
    if (isMediaId(data?.nextMediaAfterNodeId)) {
      nextId = data.nextMediaAfterNodeId;
    }
    if (data?.currMedia) {
      currMedia = data.currMedia;
    }
    if (data?.mediaset?.currMedia?.edges?.[0]?.node) {
      currMedia = data.mediaset.currMedia.edges[0].node;
    }
  }

  return { currMedia, nextId };
}

/**
 * Fetch attachments for a story as an async generator.
 * @param {Story} story
 * @yields {Media}
 */
async function* fetchAttachments(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);

    // Handle Instagram placeholder (fetch on download)
    if (s.placeholder && s.shortcode) {
      try {
        // Step 1: Try to extract from page DOM first (existing logic)
        const articles = document.querySelectorAll("article");
        for (const article of articles) {
          const link = article.querySelector(
            'a[href*="/p/"], a[href*="/reels/"], a[href*="/reel/"]',
          );
          if (link) {
            const href = link.getAttribute("href") || "";
            const match = href.match(/\/(?:p|reels|reel)\/([A-Za-z0-9_-]+)/);
            if (match && match[1] === s.shortcode) {
              const media = [];
              const imgs = article.querySelectorAll("img");
              for (const img of imgs) {
                const src =
                  img.src ||
                  img.getAttribute("data-src") ||
                  img.getAttribute("data-lazy-src") ||
                  img.currentSrc;
                if (
                  src &&
                  src.includes("cdninstagram.com") &&
                  !src.includes("profile") &&
                  !src.includes("s150x150") &&
                  !src.includes("s320x320") &&
                  !src.includes("s640x640")
                ) {
                  media.push({ __typename: "Photo", display_url: src });
                }
              }
              const videos = article.querySelectorAll("video");
              for (const video of videos) {
                const sources = video.querySelectorAll("source");
                for (const source of sources) {
                  const src =
                    source.src ||
                    source.getAttribute("data-src") ||
                    source.dataset.src;
                  if (src && src.includes("cdninstagram.com")) {
                    media.push({ __typename: "Video", video_url: src });
                  }
                }
                if (!sources.length) {
                  const src =
                    video.src ||
                    video.getAttribute("data-video-src") ||
                    video.dataset.videoSrc;
                  if (src && src.includes("cdninstagram.com")) {
                    media.push({ __typename: "Video", video_url: src });
                  }
                }
              }
              if (media.length > 0) {
                for (const m of media) {
                  yield m;
                }
                return;
              }
            }
          }
        }

        // Step 2: Try to find in cache or embedded data first
        const cached = globalStoriesCache.get(s.shortcode);
        if (cached && !cached.placeholder) {
          console.log(
            `[fpdl] Resolved placeholder ${s.shortcode} from global cache`,
          );
          yield* fetchAttachments(cached);
          return;
        }

        const embedded = extractEmbeddedStories();
        const found = embedded.find(
          (story) =>
            getStoryPostId(story) === s.shortcode && !story.placeholder,
        );
        if (found) {
          console.log(
            `[fpdl] Resolved placeholder ${s.shortcode} from embedded data`,
          );
          globalStoriesCache.set(s.shortcode, found);
          yield* fetchAttachments(found);
          return;
        }

        // Step 3: Fetch the HTML page and parse meta tags
        const instagramUrl = `https://www.instagram.com/p/${s.shortcode}/`;
        console.log(
          `[fpdl] Placeholder ${s.shortcode} not found in cache/embedded. Fetching ${instagramUrl}...`,
        );

        const res = await fetch(instagramUrl);
        if (!res.ok) {
          throw new Error(`Failed to fetch Instagram page: HTTP ${res.status}`);
        }
        const html = await res.text();

        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");

        const ogVideoMeta = doc.querySelector('meta[property="og:video"]');
        const ogImageMeta = doc.querySelector('meta[property="og:image"]');

        if (ogVideoMeta && ogVideoMeta.content) {
          console.log(
            `[fpdl] Resolved placeholder ${s.shortcode} from og:video meta tag.`,
          );
          yield { __typename: "Video", video_url: ogVideoMeta.content };
          return;
        }
        if (ogImageMeta && ogImageMeta.content) {
          console.log(
            `[fpdl] Resolved placeholder ${s.shortcode} from og:image meta tag.`,
          );
          yield { __typename: "Photo", display_url: ogImageMeta.content };
          return;
        }


        // Fallback: Deep scan script tags if meta tags don't provide media
        console.log(
          `[fpdl] No media in meta tags for ${s.shortcode}. Performing deep script scan...`,
        );
        const allScripts = doc.querySelectorAll("script:not([src])");
        for (const script of allScripts) {
          const text = script.textContent || "";
          if (text.includes(s.shortcode)) {
            try {
              if (
                text.includes("window.__additionalDataLoaded") ||
                text.includes("window.__p") ||
                text.includes("window.__w") ||
                text.includes("xdt_shortcode_media") ||
                text.includes("GraphVideo") ||
                text.includes("GraphImage")
              ) {
                const matches = text.match(/\{"__typename":"[A-Za-z]+",.*?\}/g);
                if (matches) {
                  for (const m of matches) {
                    try {
                      const parsed = JSON.parse(m);
                      if (
                        (parsed.shortcode === s.shortcode ||
                          parsed.code === s.shortcode) &&
                        !parsed.placeholder
                      ) {
                        console.log(
                          `[fpdl] Found ${s.shortcode} in deep script scan!`,
                        );
                        globalStoriesCache.set(s.shortcode, parsed);
                        yield* fetchAttachments(parsed);
                        return;
                      }
                    } catch {
                      /* ignore */
                    }
                  }
                }
              }
            } catch (e) {
              /* ignore */
            }
          }
        }

        throw new Error(
          `Could not find media data for Instagram placeholder ${s.shortcode}`,
        );
      } catch (err) {
        console.warn("[fpdl] Failed to fetch instagram placeholder", err);
      }
    }

    if (s.edge_sidecar_to_children?.edges) {
      for (const edge of s.edge_sidecar_to_children.edges) {
        yield edge.node;
      }
    } else if (s.carousel_media) {
      for (const item of s.carousel_media) {
        yield item;
      }
    } else {
      yield s;
    }
    return;
  }

  // Handle placeholder stories (Reels where we rely on "fetch on download")
  if (/** @type {any} */ (story).placeholder) {
    try {
      const results = await sendGraphqlRequest({
        apiName: VIDEO_ROOT_QUERY,
        variables: { videoID: story.id },
      });

      const extracted = [];
      extractStories(results, extracted);

      // Find the video that matches the placeholder ID
      const match = extracted.find((s) => s.id === story.id);

      if (match && match.__typename === "Video") {
        yield /** @type {MediaVideo} */ (match);
        return;
      }

      // If exact ID match fails, check if we found ANY valid video story in the response
      // (sometimes the ID in response differs slightly or is the post_id)
      if (extracted.length > 0) {
        const firstVideo = extracted.find((s) => s.__typename === "Video");
        if (firstVideo) {
          yield /** @type {MediaVideo} */ (firstVideo);
          return;
        }
      }
    } catch (err) {
      console.warn("[fpdl] Failed to fetch placeholder story data", err);
    }
    return;
  }

  // Handle bare Video objects (Reels) first, as they don't have attachments array
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      yield story; // The story object IS the media
      return;
    }
  }

  if (!story.attachments || story.attachments.length === 0) return;

  // For StoryPost, walk through the media set
  if (isStoryPost(story)) {
    const totalCount = getAttachmentCount(story);
    let downloadedCount = 0;
    /** @type {MediaId | undefined} */
    let currentId;

    // First, use media directly from the story attachment
    const attachment = story.attachments[0]?.styles?.attachment;
    if (attachment && "all_subattachments" in attachment) {
      // Multiple media - use all_subattachments
      for (const node of attachment.all_subattachments.nodes) {
        if (node?.media) {
          yield node.media;
          downloadedCount++;
          currentId = node.media;
        }
      }
    } else if (attachment && "media" in attachment && attachment.media) {
      // Single media
      yield attachment.media;
      downloadedCount++;
      currentId = attachment.media;
    } else {
      // Check for shorts video (fb_shorts_story with attachments)
      const shortsAttachments = /** @type {any} */ (attachment)
        ?.style_infos?.[0]?.fb_shorts_story?.attachments;
      if (Array.isArray(shortsAttachments) && shortsAttachments.length > 0) {
        for (const shortsNode of shortsAttachments) {
          if (shortsNode?.media) {
            yield shortsNode.media;
            downloadedCount++;
            currentId = shortsNode.media;
          }
        }
      }
    }

    // If we still need more, use media navigation starting from the last downloaded media
    if (downloadedCount < totalCount && currentId) {
      const mediasetToken = `pcb.${story.post_id}`;

      // Get the nextId from the last downloaded media
      let nav = await fetchMediaNav(currentId, mediasetToken);
      currentId = nav.nextId;

      while (currentId && downloadedCount < totalCount) {
        nav = await fetchMediaNav(currentId, mediasetToken);
        if (!nav.currMedia) break;
        downloadedCount++;
        yield nav.currMedia;
        currentId = nav.nextId;
      }
    }
  }

  // For StoryWatch, use cached video URL
  if (isStoryWatch(story)) {
    const videoId = story.attachments[0].media.id;
    const videoUrl = videoUrlCache.get(videoId);
    if (videoUrl) {
      /** @type {MediaWatch} */
      const media = {
        __typename: "Video",
        id: videoId,
        url: videoUrl,
      };
      yield media;
    }
  }
}

/**
 * Sanitize a string for use in a filename.
 * @param {string} str
 * @returns {string}
 */
function sanitizeFilename(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim();
}

/**
 * Build the folder name for a story download.
 * Format: {date:YYYY-MM-DD}_{groupName}_{actorName}_{post_id}
 * @param {Story} story
 * @returns {string}
 */
function buildFolderName(story) {
  const parts = [];

  // Date part
  const createTime = getCreateTime(story);
  if (createTime) {
    const year = createTime.getFullYear();
    const month = String(createTime.getMonth() + 1).padStart(2, "0");
    const day = String(createTime.getDate()).padStart(2, "0");
    parts.push(`${year}-${month}-${day}`);
  }

  // Group name part
  const group = getGroup(story);
  const sanitizedGroup = group ? sanitizeFilename(group.name) : "";
  if (sanitizedGroup) {
    parts.push(sanitizedGroup);
  }

  // Actor name part
  const actor = getStoryActor(story);
  const sanitizedActor = actor ? sanitizeFilename(actor.name) : "";
  if (sanitizedActor) {
    parts.push(sanitizedActor);
  }

  // Post ID part (always included)
  const postId = getStoryPostId(story);
  if (postId) {
    parts.push(sanitizeFilename(postId));
  }

  return parts.filter(Boolean).join("_");
}

/**
 * Render a story to markdown content.
 * @param {Story} story
 * @param {Array<{ media: Media, filename: string }>} attachments
 * @param {string} [quoted_story] - Pre-rendered quoted story content
 * @returns {string}
 */
function renderStory(story, attachments, quoted_story) {
  const lines = [];

  // URL
  lines.push(`**URL:** ${getStoryUrl(story)}`);
  lines.push("");

  // Group
  const group = getGroup(story);
  if (group) {
    lines.push(`**Group:** ${group.name}`);
    lines.push("");
  }

  // Actor
  const actor = getStoryActor(story);
  if (actor) {
    lines.push(`**Author:** ${actor.name}`);
    lines.push("");
  }

  // Create time
  const createTime = getCreateTime(story);
  if (createTime) {
    lines.push(`**Date:** ${createTime.toISOString()}`);
    lines.push("");
  }

  // Video title (for StoryVideo/StoryWatch with media title)
  const mediaTitle = getStoryMediaTitle(story);
  if (mediaTitle) {
    lines.push("---");
    lines.push("");
    lines.push(`**${mediaTitle}**`);
    lines.push("");
  }

  // Message
  const message = getStoryMessage(story);
  if (message) {
    lines.push("---");
    lines.push("");
    lines.push(message);
    lines.push("");
  }

  // Attachments
  if (attachments.length > 0) {
    lines.push("---");
    lines.push("");
    for (const { media, filename } of attachments) {
      const basename = filename.split("/").pop() || filename;
      if (media.__typename === "Video") {
        lines.push(`- [${basename}](./${basename})`);
      } else {
        lines.push(`![${basename}](./${basename})`);
      }
    }
    lines.push("");
  }

  // Quoted story
  if (quoted_story) {
    lines.push("---");
    lines.push("");
    // Prefix each line with "> " for blockquote
    const quotedLines = quoted_story.split("\n").map((line) => `> ${line}`);
    lines.push(...quotedLines);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Fetch story files for download.
 * @param {Story} story
 * @yields {StoryFile}
 */
export async function* fetchStoryFiles(story) {
  const folder = buildFolderName(story);
  const storyId = getStoryId(story);

  /** @type {Array<{ media: Media, filename: string }>} */
  const downloadedAttachments = [];
  let mediaIndex = 0;

  for await (const media of fetchAttachments(story)) {
    const download = getDownloadUrl(media);
    if (!download) continue;

    mediaIndex++;
    const indexPrefix = String(mediaIndex).padStart(4, "0");
    const filename = `${folder}/${indexPrefix}_${media.id}.${download.ext}`;
    yield { storyId, url: download.url, filename };
    downloadedAttachments.push({ media, filename });
  }

  // Fetch attachments for attached_story if it exists
  /** @type {string | undefined} */
  let quotedStory;
  if (isStoryPost(story) && story.attached_story) {
    /** @type {Array<{ media: Media, filename: string }>} */
    const attachedStoryAttachments = [];
    for await (const media of fetchAttachments(story.attached_story)) {
      const download = getDownloadUrl(media);
      if (!download) continue;

      mediaIndex++;
      const indexPrefix = String(mediaIndex).padStart(4, "0");
      const filename = `${folder}/${indexPrefix}_${media.id}.${download.ext}`;
      yield { storyId, url: download.url, filename };
      attachedStoryAttachments.push({ media, filename });
    }
    quotedStory = renderStory(story.attached_story, attachedStoryAttachments);
  }

  // const indexMarkdown = renderStory(story, downloadedAttachments, quotedStory);
  // const indexDataUrl =
  //   "data:text/markdown;charset=utf-8," + encodeURIComponent(indexMarkdown);
  // yield { storyId, url: indexDataUrl, filename: `${folder}/index.md` };
}

/**
 * Get the creation time for a story.
 * @param {Story} story
 * @returns {Date | undefined}
 */
export function getCreateTime(story) {
  // For InstagramStory
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    if (typeof s.taken_at_timestamp === "number") {
      return new Date(s.taken_at_timestamp * 1000);
    }
    return undefined;
  }

  // For StoryVideo, get publish_time directly from the media
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      if (typeof story.publish_time === "number") {
        return new Date(story.publish_time * 1000);
      }
      return undefined;
    }
    const publishTime = story.attachments[0].media.publish_time;
    return new Date(publishTime * 1000);
  }

  // For StoryPost and StoryWatch, use the cache
  if (isStoryPost(story) || isStoryWatch(story)) {
    const createTime = storyCreateTimeCache.get(getStoryId(story));
    if (createTime === undefined) return undefined;
    return new Date(createTime * 1000);
  }

  return undefined;
}

/**
 * Get the group for a story.
 * @param {Story} story
 * @returns {Group | undefined}
 */
export function getGroup(story) {
  return storyGroupCache.get(getStoryId(story));
}

/**
 * Get the URL for a story.
 * @param {Story} story
 * @returns {string}
 */
export function getStoryUrl(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    return `https://www.instagram.com/reels/${s.shortcode}/`;
  }
  if (isStoryPost(story)) {
    return story.wwwURL;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return `https://www.facebook.com/watch/?v=${story.id}`;
    }
    return `https://www.facebook.com/watch/?v=${story.attachments[0].media.id}`;
  }
  if (isStoryWatch(story)) {
    return `https://www.facebook.com/watch/?v=${story.attachments[0].media.id}`;
  }
  return "";
}

/**
 * Get the message text for a story.
 * @param {Story} story
 * @returns {string | undefined}
 */
export function getStoryMessage(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    return s.edge_media_to_caption?.edges?.[0]?.node?.text;
  }
  if (isStoryPost(story)) {
    return story.message?.text;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.message?.text || story.name || story.title?.text;
    }
    return story.message?.text;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.creation_story.comet_sections.message
      ?.story?.message?.text;
  }
  return undefined;
}

/**
 * Get the post_id for a story.
 * @param {Story} story
 * @returns {string}
 */
export function getStoryPostId(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    return s.shortcode || s.code || s.pk || s.id;
  }
  if (isStoryPost(story)) {
    return story.post_id;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.id;
    }
    return story.post_id;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.id;
  }
  throw new Error("Unknown story type: cannot get post_id");
}

/**
 * Get the id for a story.
 * @param {Story} story
 * @returns {string}
 */
export function getStoryId(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    return s.id || s.pk || s.shortcode || s.code;
  }
  if (isStoryPost(story)) {
    return story.id;
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.id;
    }
    return story.id;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.creation_story.id;
  }
  throw new Error("Unknown story type: cannot get id");
}

/**
 * Get the primary actor for a story.
 * @param {Story} story
 * @returns {User | undefined}
 */
export function getStoryActor(story) {
  if (isInstagramStory(story)) {
    const s = /** @type {any} */ (story);
    if (s.owner) {
      return {
        id: s.owner.id,
        name: s.owner.full_name || s.owner.username,
        username: s.owner.username,
      };
    }
    return undefined;
  }
  if (isStoryPost(story)) {
    return story.actors?.[0];
  }
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.owner;
    }
    return story.actors?.[0];
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.owner;
  }
  return undefined;
}

/**
 * Get the media title for a story (video name/title).
 * @param {Story} story
 * @returns {string | undefined}
 */
export function getStoryMediaTitle(story) {
  if (isStoryVideo(story)) {
    if (story.__typename === "Video") {
      return story.name || story.title?.text;
    }
    return story.attachments[0].media.name;
  }
  if (isStoryWatch(story)) {
    return story.attachments[0].media.title?.text;
  }
  return undefined;
}

/**
 * Check if an object is a valid StoryPost.
 * @param {unknown} obj
 * @returns {obj is StoryPost}
 */
export function isStoryPost(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  // Must have id, post_id, and wwwURL
  if (typeof o.id !== "string" || !o.id) return false;
  if (typeof o.post_id !== "string" || !o.post_id) return false;
  if (typeof o.wwwURL !== "string" || !o.wwwURL) return false;

  // Must have attachments array
  if (!Array.isArray(o.attachments)) return false;

  return true;
}

/**
 * Check if an object is a valid StoryVideo (Feed video or Reel/Video node).
 * @param {unknown} obj
 * @returns {obj is StoryVideo}
 */
function isStoryVideo(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  // Case 1: Feed Unit style (wrapper with attachments)
  if (Array.isArray(o.attachments) && o.attachments.length > 0) {
    const attachment = /** @type {Record<string, unknown>} */ (
      o.attachments[0]
    );
    if (
      typeof attachment?.url === "string" &&
      attachment.media &&
      typeof attachment.media === "object"
    ) {
      const media = /** @type {Record<string, unknown>} */ (attachment.media);
      return (
        media.__typename === "Video" && typeof media.publish_time === "number"
      );
    }
  }

  // Case 2: Direct Video Node (Reels/Watch) or Placeholder
  // The object itself is the Video media.
  if (o.__typename === "Video" && typeof o.id === "string") {
    // Placeholder
    if (/** @type {any} */ (o).placeholder) return true;

    // Must have playable url or delivery
    if (typeof o.playable_url === "string") return true;
    if (o.video_grid_renderer || o.videoDeliveryResponseFragment) return true;
  }

  return false;
}

/**
 * Check if an object is a valid StoryWatch.
 * @param {unknown} obj
 * @returns {obj is StoryWatch}
 */
function isStoryWatch(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  // Must have attachments array
  if (!Array.isArray(o.attachments)) return false;
  if (o.attachments.length === 0) return false;

  const attachment = /** @type {Record<string, unknown>} */ (o.attachments[0]);
  if (!attachment.media || typeof attachment.media !== "object") return false;

  const media = /** @type {Record<string, unknown>} */ (attachment.media);
  if (media.__typename !== "Video") return false;

  // Must have creation_story with comet_sections
  if (!media.creation_story || typeof media.creation_story !== "object")
    return false;
  const creationStory = /** @type {Record<string, unknown>} */ (
    media.creation_story
  );
  if (
    !creationStory.comet_sections ||
    typeof creationStory.comet_sections !== "object"
  )
    return false;

  return true;
}

/**
 * Check if an object is a valid StoryReel.
 * @param {unknown} obj
 * @returns {obj is StoryWatch}
 */
export function isStoryReel(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  // Must have attachments array
  if (!Array.isArray(o.attachments)) return false;
  if (o.attachments.length === 0) return false;

  const attachment = /** @type {Record<string, unknown>} */ (o.attachments[0]);
  if (!attachment.media || typeof attachment.media !== "object") return false;

  const media = /** @type {Record<string, unknown>} */ (attachment.media);
  if (media.__typename !== "Video") return false;

  // Reels typically have 'owner' directly on media, or specific 'is_reel' flags,
  // but importantly they differ from Watch stories in structure.
  // For now, if it's a Video and not Watch (no creation_story complexity) and not Feed (has attachments array), it's likely a Reel or simple video.
  // But wait, `isStoryWatch` checks for `creation_story`.
  // `isStoryVideo` is for `CometFeedUnit` style.

  // The GraphQL responses for Reels (CometVideoRootMediaViewerQuery) often look like { data: { video: { ... } } }
  // or { data: { node: { ... } } } where node is the video.
  // We need to match the structure we extract.

  // If we extracted a 'video' node directly from the response and wrapped it into a Story-like structure?
  // No, `extractStories` works on the raw JSON tree.

  // Let's assume a "Reel" looks like a Video object that has `id`, `playable_url` or `video_grid_renderer`?
  // Actually, we need to see what `extractStories` finds.

  // If we want to support the user's specific Reel `2196583207753065`, it's a `CometVideoRootMediaViewerQuery`.
  // The response usually contains a `video` field.

  // Let's broaden the definition:
  // If an object has `__typename === 'Video'`, acts as its own story?
  // Current logic expects a wrapper object with `attachments`.

  return false;
}

// We need to inspect the raw data structure for Reels.
// Since I cannot debug, I will implement a permissive "StoryVideo" check that handles the Reel case.

/**
 * Check if an object is an Instagram media item.
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isInstagramStory(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (obj);

  if (o.__typename === "InstagramStory" || o.placeholder === true) return true;

  // Common Instagram GraphQL/API Typenames
  const typenames = new Set([
    "XDTGraphVideo",
    "XDTGraphImage",
    "XDTGraphSidecar",
    "GraphVideo",
    "GraphImage",
    "GraphSidecar",
    "XDTGraphMedia",
    "GraphMedia",
    "StoryVideo",
    "StoryImage",
  ]);

  if (typenames.has(String(o.__typename))) {
    return !!(o.shortcode || o.id || o.code);
  }

  if (
    (o.code ||
      o.shortcode ||
      o.pk ||
      (typeof o.id === "string" && o.id.includes("_"))) &&
    (o.image_versions2 ||
      o.video_versions ||
      o.display_url ||
      o.carousel_media ||
      o.media_type)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if an object is a valid Story (StoryPost, StoryVideo, or StoryWatch).
 * @param {unknown} obj
 * @returns {obj is Story}
 */
function isStory(obj) {
  return (
    isInstagramStory(obj) ||
    isStoryPost(obj) ||
    isStoryVideo(obj) ||
    isStoryWatch(obj)
  );
}

/**
 * Recursively extract stories from deeply nested objects.
 * Stories are identified by having id, post_id, and attachments array.
 * @param {unknown} obj
 * @param {Story[]} [results] - Array to collect stories
 * @returns {Story[]}
 */
export function extractStories(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;

  const o = /** @type {Record<string, unknown>} */ (obj);

  // Check if this object is a valid story
  const objIsStory = isStory(obj);
  if (objIsStory) {
    const id = getStoryId(obj);
    if (id) {
      // Deduplicate in results
      const exists = results.some((s) => getStoryId(s) === id);
      if (!exists) {
        results.push(obj);
      }

      // Populate global cache for placeholder resolution
      const postId = getStoryPostId(obj);
      if (postId && !(/** @type {any} */ (obj).placeholder)) {
        globalStoriesCache.set(postId, obj);
      }
    }
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStories(item, results);
    }
  } else {
    const keys = Object.keys(o);
    for (const key of keys) {
      // Skip attached_story for story objects - it should remain nested, not extracted separately
      if (objIsStory && key === "attached_story") continue;
      extractStories(o[key], results);
    }
  }

  return results;
}

/**
 * Recursively extract metadata (creation_time, url) from deeply nested objects
 * and populate storyCreateTimeCache directly.
 * @param {unknown} obj
 */
export function extractStoryCreateTime(obj) {
  if (!obj || typeof obj !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (obj);

  // Check if this object has creation_time, id and url (metadata object)
  if (
    typeof o.creation_time === "number" &&
    typeof o.id === "string" &&
    typeof o.url === "string"
  ) {
    storyCreateTimeCache.set(o.id, o.creation_time);
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStoryCreateTime(item);
    }
  } else {
    for (const key of Object.keys(o)) {
      extractStoryCreateTime(o[key]);
    }
  }
}

/**
 * Recursively extract group info from deeply nested objects
 * and populate storyGroupCache directly.
 * @param {unknown} obj
 */
export function extractStoryGroupMap(obj) {
  if (!obj || typeof obj !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (obj);

  // Check if this object has id (string) and to.__typename === "Group"
  if (typeof o.id === "string" && o.to && typeof o.to === "object") {
    const to = /** @type {Record<string, unknown>} */ (o.to);
    if (
      to.__typename === "Group" &&
      typeof to.id === "string" &&
      typeof to.name === "string"
    ) {
      // Only set if not already present (prefer first/most complete match)
      if (!storyGroupCache.has(o.id)) {
        storyGroupCache.set(o.id, /** @type {Group} */ (to));
      }
    }
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStoryGroupMap(item);
    }
  } else {
    for (const key of Object.keys(o)) {
      extractStoryGroupMap(o[key]);
    }
  }
}

/**
 * Extract video URLs from all_video_dash_prefetch_representations in extensions field
 * and populate videoUrlCache directly.
 * @param {unknown} obj
 */
export function extractVideoUrls(obj) {
  if (!obj || typeof obj !== "object") return;

  const o = /** @type {Record<string, unknown>} */ (obj);

  // Check if this object has all_video_dash_prefetch_representations
  if (Array.isArray(o.all_video_dash_prefetch_representations)) {
    for (const prefetch of o.all_video_dash_prefetch_representations) {
      if (!prefetch || typeof prefetch !== "object") continue;
      const p = /** @type {Record<string, unknown>} */ (prefetch);
      const videoId = p.video_id;
      if (typeof videoId !== "string") continue;
      if (videoUrlCache.has(videoId)) continue;

      // Find the best video representation (highest bandwidth, excluding audio-only)
      const representations = p.representations;
      if (!Array.isArray(representations)) continue;

      /** @type {{ base_url: string, bandwidth: number } | null} */
      let best = null;
      for (const rep of representations) {
        if (!rep || typeof rep !== "object") continue;
        const r = /** @type {Record<string, unknown>} */ (rep);
        const baseUrl = r.base_url;
        const bandwidth = r.bandwidth;
        const mimeType = r.mime_type;

        // Skip audio-only tracks
        if (typeof mimeType === "string" && mimeType.startsWith("audio/"))
          continue;

        if (typeof baseUrl === "string" && typeof bandwidth === "number") {
          if (!best || bandwidth > best.bandwidth) {
            best = { base_url: baseUrl, bandwidth };
          }
        }
      }

      if (best) {
        videoUrlCache.set(videoId, best.base_url);
      }
    }
  }

  // Recurse into arrays and objects
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractVideoUrls(item);
    }
  } else {
    for (const key of Object.keys(o)) {
      extractVideoUrls(o[key]);
    }
  }
}

/**
 * Extract stories embedded in the initial HTML page load.
 * These are delivered via <script type="application/json"> tags or window variables.
 * @returns {Story[]}
 */
function extractEmbeddedStories() {
  /** @type {Story[]} */
  const stories = [];

  const scripts = document.querySelectorAll('script[type="application/json"]');
  for (const script of scripts) {
    const content = script.textContent;
    if (!content) continue;

    try {
      const data = JSON.parse(content);
      extractStories(data, stories);
      extractStoryCreateTime(data);
      extractStoryGroupMap(data);
      extractVideoUrls(data);
    } catch {
      // ignore parse errors
    }
  }

  // Instagram specific embedded data
  if (window.location.hostname.includes("instagram.com")) {
    try {
      // @ts-ignore
      if (window._sharedData) extractStories(window._sharedData, stories);
      // @ts-ignore
      if (window.__additionalData)
        extractStories(window.__additionalData, stories);
      // @ts-ignore
      if (window.__player_data) extractStories(window.__player_data, stories);
    } catch {
      // ignore
    }
  }

  // Populate global cache from found stories
  for (const s of stories) {
    const postId = getStoryPostId(s);
    if (postId && !s.placeholder) {
      globalStoriesCache.set(postId, s);
    }
  }

  return stories;
}

/**
 * Facebook uses different GraphQL operation ("friendly") names depending on context.
 * ...
 */
const TARGET_API_NAMES = new Set([
  "CometGroupDiscussionRootSuccessQuery",
  "CometModernHomeFeedQuery",
  "CometNewsFeedPaginationQuery",
  "CometVideoHomeFeedRootQuery",
  "CometVideoHomeFeedSectionPaginationQuery",
  "GroupsCometCrossGroupFeedContainerQuery",
  "GroupsCometCrossGroupFeedPaginationQuery",
  "GroupsCometFeedRegularStoriesPaginationQuery",
  "ProfileCometContextualProfileGroupPostsFeedPaginationQuery",
  "ProfileCometContextualProfileRootQuery",
  "ProfileCometTimelineFeedQuery",
  "ProfileCometTimelineFeedRefetchQuery",
  "SearchCometResultsInitialResultsQuery",
  "SearchCometResultsPaginatedResultsQuery",
  "CometVideoRootMediaViewerQuery",
  "CometPhotoRootContentQuery",
]);

/**
 * @param {(story: Story) => void} cb
 * @returns {() => void}
 */
export function storyListener(cb) {
  // Poll for embedded stories every 1000ms for 30 seconds
  /** @type {Set<string>} */
  const emittedStoryIds = new Set();

  let elapsed = 0;
  const pollInterval = 1000;
  const maxDuration = 30000;

  const intervalId = setInterval(() => {
    elapsed += pollInterval;

    const embeddedStories = extractEmbeddedStories();
    for (const story of embeddedStories) {
      const storyId = getStoryId(story);
      if (emittedStoryIds.has(storyId)) continue;
      emittedStoryIds.add(storyId);
      try {
        cb(story);
      } catch {
        // ignore listener errors
      }
    }

    if (elapsed >= maxDuration) {
      clearInterval(intervalId);
    }
  }, pollInterval);

  // Then listen for new stories from GraphQL responses
  return graphqlListener((ev) => {
    const isInstagram = ev.url.includes("instagram.com");

    const apiName =
      ev.requestHeaders["x-fb-friendly-name"] ||
      ev.requestPayload["fb_api_req_friendly_name"];

    let isTarget = false;
    if (isInstagram) {
      isTarget = true;
    } else if (apiName) {
      isTarget =
        TARGET_API_NAMES.has(apiName) ||
        apiName.includes("Video") ||
        apiName.includes("Reel") ||
        apiName.includes("Clip");
    }

    if (!isTarget) return;

    const stories = extractStories(ev.responseBody);
    extractStoryCreateTime(ev.responseBody);
    extractStoryGroupMap(ev.responseBody);
    extractVideoUrls(ev.responseBody);

    for (const story of stories) {
      const storyId = getStoryId(story);
      // Cache all valid stories by their ID/shortcode for placeholder resolution
      const postId = getStoryPostId(story);
      if (postId && !story.placeholder) {
        globalStoriesCache.set(postId, story);
      }

      if (emittedStoryIds.has(storyId)) continue;
      emittedStoryIds.add(storyId);
      try {
        cb(story);
      } catch {
        // ignore listener errors
      }
    }
  });
}
