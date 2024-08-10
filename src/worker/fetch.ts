import { BareResponseFetch } from "@mercuryworkshop/bare-mux";
import IDBMap from "@webreflection/idb-map";
import { ParseResultType } from "parse-domain";
import { ScramjetServiceWorker } from ".";
import { renderError } from "./error";
import { FakeServiceWorker } from "./fakesw";
import { CookieStore } from "../shared/cookie";

const { encodeUrl, decodeUrl } = self.$scramjet.shared.url;
const { rewriteHeaders, rewriteHtml, rewriteJs, rewriteCss, rewriteWorkers } =
	self.$scramjet.shared.rewrite;
const { parseDomain, ScramjetHeaders } = self.$scramjet.shared.util;

export async function swfetch(
	this: ScramjetServiceWorker,
	{ request }: FetchEvent
) {
	if (new URL(request.url).pathname.startsWith("/scramjet/worker")) {
		const dataurl = new URL(request.url).searchParams.get("data");
		const res = await fetch(dataurl);
		const ab = await res.arrayBuffer();

		const ismodule = new URL(request.url).searchParams.get("type") === "module";

		const origin = new URL(
			decodeURIComponent(new URL(request.url).searchParams.get("origin"))
		);

		if (ismodule) origin.searchParams.set("type", "module");

		const rewritten = rewriteWorkers(ab, new URL(origin));

		return new Response(rewritten, {
			headers: {
				"Content-Type": "application/javascript",
			},
		});
	}

	const urlParam = new URLSearchParams(new URL(request.url).search);

	if (urlParam.has("url")) {
		return Response.redirect(
			encodeUrl(urlParam.get("url"), new URL(urlParam.get("url")))
		);
	}

	try {
		const url = new URL(decodeUrl(request.url));

		const activeWorker: FakeServiceWorker | null = this.serviceWorkers.find(
			(w) => w.origin === url.origin
		);

		if (
			activeWorker &&
			activeWorker.connected &&
			urlParam.get("from") !== "swruntime"
		) {
			// TODO: check scope
			const r = await activeWorker.fetch(request);
			if (r) return r;
		}
		if (url.origin == new URL(request.url).origin) {
			throw new Error(
				"attempted to fetch from same origin - this means the site has obtained a reference to the real origin, aborting"
			);
		}

		const headers = new ScramjetHeaders();
		for (const [key, value] of request.headers.entries()) {
			headers.set(key, value);
		}

		if (new URL(request.referrer).pathname != "/")
			headers.set("Referer", decodeUrl(request.referrer));

		const cookies = this.cookieStore.getCookies(url, false);

		if (cookies.length) {
			headers.set("Cookie", cookies);
		}

		// TODO this is wrong somehow
		headers.set("Sec-Fetch-Mode", "navigate");
		headers.set("Sec-Fetch-Site", "same-origin");

		if (new URL(request.referrer).pathname != "/")
			headers.set("Origin", new URL(request.referrer).origin);

		headers.set("User-Agent", "https://accounts.google.com");

		dbg.log(url.toString(), headers.headers);

		const response: BareResponseFetch = await this.client.fetch(url, {
			method: request.method,
			body: request.body,
			headers: headers.headers,
			credentials: "omit",
			mode: request.mode === "cors" ? request.mode : "same-origin",
			cache: request.cache,
			redirect: "manual",
			//@ts-ignore why the fuck is this not typed mircosoft
			duplex: "half",
		});

		return await handleResponse(
			url,
			request.destination,
			response,
			this.cookieStore
		);
	} catch (err) {
		console.error("ERROR FROM SERVICE WORKER FETCH", err);
		if (!["document", "iframe"].includes(request.destination))
			return new Response(undefined, { status: 500 });

		return renderError(err, decodeUrl(request.url));
	}
}

async function handleResponse(
	url: URL,
	destination: RequestDestination,
	response: BareResponseFetch,
	cookieStore: CookieStore
): Promise<Response> {
	let responseBody: string | ArrayBuffer | ReadableStream;
	const responseHeaders = rewriteHeaders(response.rawHeaders, url);

	await handleCookies(
		url,
		cookieStore,
		(responseHeaders["set-cookie"] || []) as string[]
	);

	for (const header in responseHeaders) {
		// flatten everything past here
		if (Array.isArray(responseHeaders[header]))
			responseHeaders[header] = responseHeaders[header][0];
	}

	if (response.body) {
		switch (destination) {
			case "iframe":
			case "document":
				if (responseHeaders["content-type"]?.startsWith("text/html")) {
					responseBody = rewriteHtml(await response.text(), cookieStore, url);
				} else {
					responseBody = response.body;
				}
				break;
			case "script":
				responseBody = rewriteJs(await response.arrayBuffer(), url);
				// Disable threading for now, it's causing issues.
				// responseBody = await this.threadpool.rewriteJs(await responseBody.arrayBuffer(), url.toString());
				break;
			case "style":
				responseBody = rewriteCss(await response.text(), url);
				break;
			case "sharedworker":
			case "worker":
				responseBody = rewriteWorkers(await response.arrayBuffer(), url);
				break;
			default:
				responseBody = response.body;
				break;
		}
	}
	// downloads
	if (["document", "iframe"].includes(destination)) {
		const header = responseHeaders["content-disposition"];

		// validate header and test for filename
		if (!/\s*?((inline|attachment);\s*?)filename=/i.test(header)) {
			// if filename= wasn"t specified then maybe the remote specified to download this as an attachment?
			// if it"s invalid then we can still possibly test for the attachment/inline type
			const type = /^\s*?attachment/i.test(header) ? "attachment" : "inline";

			// set the filename
			const [filename] = new URL(response.finalURL).pathname
				.split("/")
				.slice(-1);

			responseHeaders["content-disposition"] =
				`${type}; filename=${JSON.stringify(filename)}`;
		}
	}
	if (responseHeaders["accept"] === "text/event-stream") {
		responseHeaders["content-type"] = "text/event-stream";
	}

	// scramjet runtime can use features that permissions-policy blocks
	delete responseHeaders["permissions-policy"];

	if (crossOriginIsolated) {
		responseHeaders["Cross-Origin-Embedder-Policy"] = "require-corp";
	}

	return new Response(responseBody, {
		headers: responseHeaders as HeadersInit,
		status: response.status,
		statusText: response.statusText,
	});
}

async function handleCookies(
	url: URL,
	cookieStore: CookieStore,
	maybeHeaders: string[] | string
) {
	const headers = maybeHeaders instanceof Array ? maybeHeaders : [maybeHeaders];

	await cookieStore.setCookies(headers, url);
}
