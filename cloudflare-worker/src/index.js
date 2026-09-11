const streamCache = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', service: 'cloudflare-audio-streamer' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const streamMatch = url.pathname.match(/^\/stream\/([a-zA-Z0-9_-]+)/);
    if (!streamMatch) {
      return new Response('Not Found', { status: 404 });
    }

    const videoId = streamMatch[1];
    const clientRange = request.headers.get('range') || 'bytes=0-';

    try {
      let meta = streamCache.get(videoId);
      if (!meta || (Date.now() - meta.timestamp > 900000)) {
        const resolveRes = await fetch(`https://youtube-music-alexa-skill.vercel.app/api/resolve-stream?v=${videoId}`, {
          headers: { 'User-Agent': 'CloudflareEdge/1.0' }
        });
        if (!resolveRes.ok) return new Response('Resolve failed', { status: 502 });
        const data = await resolveRes.json();
        if (!data.streamUrl) return new Response('No stream URL', { status: 404 });
        meta = { streamUrl: data.streamUrl, timestamp: Date.now() };
        streamCache.set(videoId, meta);
      }

      // Fetch from Google Video CDN with Range
      const googleRes = await fetch(meta.streamUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Range': clientRange
        }
      });

      if (googleRes.status === 403) {
        // Clear cache and re-resolve once
        streamCache.delete(videoId);
        const retryRes = await fetch(`https://youtube-music-alexa-skill.vercel.app/api/resolve-stream?v=${videoId}`);
        const retryData = await retryRes.json();
        if (retryData && retryData.streamUrl) {
          streamCache.set(videoId, { streamUrl: retryData.streamUrl, timestamp: Date.now() });
          const retryGoogle = await fetch(retryData.streamUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
              'Accept': '*/*',
              'Range': clientRange
            }
          });
          const resHeaders = new Headers({
            'Content-Type': 'audio/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600'
          });
          if (retryGoogle.headers.get('content-length')) resHeaders.set('Content-Length', retryGoogle.headers.get('content-length'));
          if (retryGoogle.headers.get('content-range')) resHeaders.set('Content-Range', retryGoogle.headers.get('content-range'));
          return new Response(retryGoogle.body, { status: retryGoogle.status, headers: resHeaders });
        }
      }

      const resHeaders = new Headers({
        'Content-Type': 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600'
      });

      if (googleRes.headers.get('content-length')) resHeaders.set('Content-Length', googleRes.headers.get('content-length'));
      if (googleRes.headers.get('content-range')) resHeaders.set('Content-Range', googleRes.headers.get('content-range'));

      return new Response(googleRes.body, {
        status: googleRes.status,
        headers: resHeaders
      });

    } catch (err) {
      return new Response('Edge Stream Error: ' + err.message, { status: 500 });
    }
  }
};
