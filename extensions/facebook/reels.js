import { sendGraphqlRequest } from "../graphql.js";

/**
 * @typedef {import('./types').Story} Story
 * @typedef {import('./types').Media} Media
 */

/**
 * Check if an object is a Facebook Reel.
 * @param {unknown} obj
 * @returns {boolean}
 */
export function isFacebookReel(obj) {
  if (!obj || typeof obj !== "object") return false;
  const o = /** @type {any} */ (obj);
  
  return (
    o.__typename === "Reel" ||
    o.__typename === "FBReel" ||
    (o.__typename === "Video" && (o.is_reel || window.location.href.includes("/reel/")))
  );
}

/**
 * Fetch a Facebook Reel's data via GraphQL.
 * @param {string} reelId
 * @returns {Promise<any>}
 */
export async function fetchReelData(reelId) {
  console.log(`[fpdl] Fetching Facebook Reel data for ${reelId}...`);
  
  try {
    // Try CometReelMediaViewerQuery first
    const results = await sendGraphqlRequest({
      apiName: "CometReelMediaViewerQuery",
      variables: { reelID: reelId },
    });
    
    if (results && results.length > 0 && results[0].data) return results;
    
    // Fallback to ClubsVideoPlayerRootQuery
    return await sendGraphqlRequest({
      apiName: "ClubsVideoPlayerRootQuery",
      variables: { videoID: reelId },
    });
  } catch (err) {
    console.warn("[fpdl] Reel GraphQL failed", err);
    return null;
  }
}

/**
 * Extract media from Reel GraphQL response.
 * @param {any[]} results
 * @param {any[]} extracted
 */
export function extractReelMedia(results, extracted) {
  const seen = new Set();
  
  function findVideos(obj) {
    if (!obj || typeof obj !== "object" || seen.has(obj)) return;
    seen.add(obj);

    if (obj.__typename === "Video" || obj.playable_url || obj.playable_url_quality_hd) {
      extracted.push(obj);
      return;
    }

    for (const key in obj) {
      findVideos(obj[key]);
    }
  }

  for (const res of results) {
    if (res && res.data) findVideos(res.data);
  }
}
