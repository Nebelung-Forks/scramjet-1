import IDBMap from "@webreflection/idb-map";
import { ScramjetConfig } from "../types";
import { Codec } from "../codecs";
import type { ScramjetClient } from "../client/client";
import { ScramjetFrame } from "./frame";

export class ScramjetController {
	config: ScramjetConfig;
	private store: IDBMap;
	codec: Codec;

	constructor(config: ScramjetConfig) {
		const defaultConfig: Partial<ScramjetConfig> = {
			prefix: "/scramjet/",
			codec: "plain",
			wrapfn: "$scramjet$wrap",
			trysetfn: "$scramjet$tryset",
			importfn: "$scramjet$import",
			rewritefn: "$scramjet$rewrite",
			metafn: "$scramjet$meta",
			setrealmfn: "$scramjet$setrealm",
			pushsourcemapfn: "$scramjet$pushsourcemap",
			wasm: "/scramjet.wasm.js",
			shared: "/scramjet.shared.js",
			worker: "/scramjet.worker.js",
			thread: "/scramjet.thread.js",
			client: "/scramjet.client.js",
			codecs: "/scramjet.codecs.js",
			sync: "/scramjet.sync.js",
			flags: {
				serviceworkers: false,
				naiiveRewriter: false,
				captureErrors: true,
				syncxhr: false,
				cleanerrors: false,
				sourcemaps: false,
			},
		};

		this.config = Object.assign({}, defaultConfig, config);
	}

	async init(serviceWorkerPath: string): Promise<ServiceWorkerRegistration> {
		await import(/* webpackIgnore: true */ this.config.codecs);
		this.codec = self.$scramjet.codecs[this.config.codec];

		this.store = new IDBMap("config", {
			prefix: "scramjet",
		});
		await this.#saveConfig();

		const reg = await navigator.serviceWorker.register(serviceWorkerPath);
		dbg.log("service worker registered");

		return reg;
	}

	createFrame(frame?: HTMLIFrameElement): ScramjetFrame {
		if (!frame) {
			frame = document.createElement("iframe");
		}

		return new ScramjetFrame(this, frame);
	}

	encodeUrl(url: string | URL): string {
		if (url instanceof URL) url = url.toString();

		return this.config.prefix + this.codec.encode(url);
	}

	async #saveConfig() {
		this.store.set("config", this.config);
	}

	async modifyConfig(config: ScramjetConfig) {
		this.config = Object.assign({}, this.config, config);
		this.codec = self.$scramjet.codecs[this.config.codec];

		await this.#saveConfig();
	}
}

window.ScramjetController = ScramjetController;
