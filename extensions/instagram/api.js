export async function fetchInstagramStoryData(userId) {
  const url = `https://i.instagram.com/api/v1/feed/user/${userId}/story/`;
  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Instagram API failed: ${res.status}`);
  const data = await res.json();

  const results = [];
  if (data.reel && Array.isArray(data.reel.items)) {
    for (const item of data.reel.items) {
      const media = {
        __typename: item.video_versions ? "Video" : "Photo",
        id: item.id || item.pk,
        pk: item.pk,
        code: item.code,
        shortcode: item.code,
        video_url: item.video_versions?.[0]?.url,
        display_url:
          item.image_versions2?.candidates?.[0]?.url || item.display_url,
        taken_at_timestamp: item.taken_at,
        owner: {
          id: data.reel?.user?.pk || item.user?.pk,
          username: data.reel?.user?.username || item.user?.username,
          full_name: data.reel?.user?.full_name || item.user?.full_name,
        },
      };
      results.push(media);
    }
  }
  return results;
}

export async function fetchInstagramHighlightData(highlightId) {
  const id = highlightId.includes(":") ? highlightId : `highlight:${highlightId}`;
  const url = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${id}`;

  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Instagram Highlight API failed: ${res.status}`);
  const data = await res.json();

  const results = [];
  const reel = data.reels?.[id] || Object.values(data.reels || {})[0];

  if (reel && Array.isArray(reel.items)) {
    for (const item of reel.items) {
      const media = {
        __typename: item.video_versions ? "Video" : "Photo",
        id: item.id || item.pk,
        pk: item.pk,
        code: item.code,
        shortcode: item.code,
        video_url: item.video_versions?.[0]?.url,
        display_url:
          item.image_versions2?.candidates?.[0]?.url || item.display_url,
        taken_at_timestamp: item.taken_at,
        owner: {
          id: reel.user?.pk || item.user?.pk,
          username: reel.user?.username || item.user?.username,
          full_name: reel.user?.full_name || item.user?.full_name,
        },
      };
      results.push(media);
    }
  }
  return results;
}

export function instagramShortcodeToId(shortcode) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = BigInt(0);
  for (let i = 0; i < shortcode.length; i++) {
    const char = shortcode[i];
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    id = id * BigInt(64) + BigInt(index);
  }
  return id.toString();
}

export async function fetchInstagramMediaInfo(shortcode) {
  const mediaId = instagramShortcodeToId(shortcode);
  const url = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;

  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) {
    const altUrl = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
    const altRes = await fetch(altUrl);
    if (!altRes.ok) return undefined;
    const data = await altRes.json();
    const item = data.items?.[0] || data.graphql?.shortcode_media;
    if (!item) return undefined;
    return {
      __typename: item.video_versions || item.is_video ? "Video" : "Photo",
      id: item.id || item.pk,
      video_url: item.video_versions?.[0]?.url || item.video_url,
      display_url:
        item.image_versions2?.candidates?.[0]?.url || item.display_url,
      owner: item.owner || item.user,
    };
  }

  const data = await res.json();
  const item = data.items?.[0];
  if (!item) return undefined;

  return {
    __typename: item.video_versions ? "Video" : "Photo",
    id: item.id || item.pk,
    video_url: item.video_versions?.[0]?.url,
    display_url: item.image_versions2?.candidates?.[0]?.url || item.display_url,
    taken_at_timestamp: item.taken_at,
    owner: {
      id: item.user.pk,
      username: item.user.username,
      full_name: item.user.full_name,
    },
  };
}

export async function resolveInstagramUserId(username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${username}`;
  const res = await fetch(url, {
    headers: {
      "x-ig-app-id": "936619743392459",
      "x-requested-with": "XMLHttpRequest",
    },
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Instagram Profile API failed: ${res.status}`);
  const json = await res.json();
  const id = json.data?.user?.id;
  if (!id) throw new Error("Could not find user ID");
  return id;
}
