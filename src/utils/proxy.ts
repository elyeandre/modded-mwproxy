import { extractHeadersFromPath } from '@/utils/headers';
import {
  Duplex,
  H3Event,
  ProxyOptions,
  RequestHeaders,
  getProxyRequestHeaders,
} from 'h3';

const PayloadMethods = new Set(['PATCH', 'POST', 'PUT', 'DELETE']);

export interface ExtraProxyOptions {
  blacklistedHeaders?: string[];
}

function mergeHeaders(
  defaults: HeadersInit,
  ...inputs: (HeadersInit | RequestHeaders | undefined)[]
) {
  const _inputs = inputs.filter(Boolean) as HeadersInit[];
  if (_inputs.length === 0) {
    return defaults;
  }
  const merged = new Headers(defaults);
  for (const input of _inputs) {
    if (input.entries) {
      for (const [key, value] of (input.entries as any)()) {
        if (value !== undefined) {
          merged.set(key, value);
        }
      }
    } else {
      for (const [key, value] of Object.entries(input)) {
        if (value !== undefined) {
          merged.set(key, value);
        }
      }
    }
  }
  return merged;
}

export async function specificProxyRequest(
  event: H3Event,
  target: string,
  opts: ProxyOptions & ExtraProxyOptions = {},
) {
  let body;
  let duplex: Duplex | undefined;
  if (PayloadMethods.has(event.method)) {
    if (opts.streamRequest) {
      body = getRequestWebStream(event);
      duplex = 'half';
    } else {
      body = await readRawBody(event, false).catch(() => undefined);
    }
  }

  const method = opts.fetchOptions?.method || event.method;
  const oldHeaders = getProxyRequestHeaders(event);
  opts.blacklistedHeaders?.forEach((header) => {
    const keys = Object.keys(oldHeaders).filter(
      (v) => v.toLowerCase() === header.toLowerCase(),
    );
    keys.forEach((k) => delete oldHeaders[k]);
  });

  const fetchHeaders = mergeHeaders(
    oldHeaders,
    opts.fetchOptions?.headers,
    opts.headers,
  );
  const headerObj = Object.fromEntries([...(fetchHeaders.entries as any)()]);
  if (process.env.REQ_DEBUG === 'true') {
    console.log({
      type: 'request',
      method,
      url: target,
      headers: headerObj,
    });
  }

  return sendProxy(event, target, {
    ...opts,
    fetchOptions: {
      method,
      body,
      duplex,
      ...opts.fetchOptions,
      headers: fetchHeaders,
    },
    async onResponse(outputEvent, response) {
      if (
        response.headers
          .get('Content-Type')
          ?.includes('application/vnd.apple.mpegurl')
      ) {
        const arrayBuffer = await response.arrayBuffer();

        let headersString = '';
        for (const [key, value] of Object.entries(
          extractHeadersFromPath(outputEvent),
        )) {
          headersString += `&${key}=${encodeURIComponent(value)}`;
        }

        const protocol = getRequestProtocol(outputEvent);
        const hostname = getRequestHost(outputEvent);
        const destination = getQuery<{ destination?: string }>(
          event,
        ).destination;

        // Convert array buffer to string
        const playlistText = new TextDecoder().decode(arrayBuffer);
        const modifiedPlaylistText = playlistText
          .split('\n')
          .map((line) => {
            if (line.startsWith('http')) {
              // Add the proxy URL and referrer query parameter
              const modifiedURL = `${protocol}://${hostname}/?destination=${encodeURIComponent(
                line,
              )}${headersString}`;
              return modifiedURL;
            } else if (line.endsWith('m3u8') && destination !== undefined) {
              // Modify playlist for vidsrcto
              const modifiedURL = `?destination=${encodeURIComponent(
                destination.replace(/\/list[^/]+\.m3u8/, ''),
              )}/${encodeURIComponent(line)}${headersString}`;
              return modifiedURL;
            } else if (line.endsWith('ts') && destination !== undefined) {
              const modifiedURL = `?destination=${destination.replace(
                /\/[^/]+\.m3u8/,
                '',
              )}/${encodeURIComponent(line)}${headersString}`;
              return modifiedURL;
            }
            return line;
          })
          .join('\n');

        const modifiedArrayBuffer = new TextEncoder().encode(
          modifiedPlaylistText,
        );
        const modifiedResponse = new Response(modifiedArrayBuffer);
        const headers = getAfterResponseHeaders(response.headers, response.url);
        setResponseHeaders(outputEvent, headers);
        sendWebResponse(outputEvent, modifiedResponse);
      } else {
        const headers = getAfterResponseHeaders(response.headers, response.url);
        setResponseHeaders(outputEvent, headers);
      }
    },
  });
}
