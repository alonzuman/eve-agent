import dns from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { httpsUrl } from "./cards.js";

const MAX_BYTES = 10 * 1024 * 1024;
export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; } catch { return false; }
}

/** Resolve and pin only public addresses at connection time, including redirects. */
export async function fetchOptionImage(input: string, abortSignal?: AbortSignal): Promise<Buffer> {
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(abortSignal ? [abortSignal] : [])]);
  async function download(input: string, redirects: number): Promise<Buffer> {
    const url = new URL(httpsUrl.parse(input));
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error("Image address is not public.");
    return new Promise((resolve, reject) => {
      const request = https.get(url, {
        signal,
        // No cookies, authorization, or user-provided request headers.
        headers: { Accept: "image/jpeg,image/png,image/webp,image/gif" },
        lookup(_hostname, options, callback) {
          dns.lookup(_hostname, { all: true, verbatim: true }).then(addresses => {
            if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
              callback(new Error("Image address is not public."), "", 4);
            } else if (options.all) {
              callback(null, addresses);
            } else {
              callback(null, addresses[0].address, addresses[0].family);
            }
          }, error => callback(error, "", 4));
        },
      }, response => {
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (!response.headers.location || redirects >= 3) return reject(new Error("Too many image redirects."));
          try { resolve(download(new URL(response.headers.location, url).href, redirects + 1)); }
          catch (error) { reject(error); }
          return;
        }
        const type = response.headers["content-type"]?.split(";")[0].trim().toLowerCase();
        if (status !== 200 || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type ?? "") || Number(response.headers["content-length"] ?? 0) > MAX_BYTES) {
          response.destroy();
          reject(new Error("Unsupported or oversized image response."));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) { response.destroy(new Error("Image exceeds 10 MB.")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
        response.on("aborted", () => reject(new Error("Image download interrupted.")));
      });
      request.on("error", reject);
    });
  }
  return download(input, 0);
}
