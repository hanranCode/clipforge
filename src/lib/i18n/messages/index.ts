import type { Locale } from "../config";
import { common } from "./common";
import { home } from "./home";
import { start } from "./start";
import { topic } from "./topic";
import { newProject } from "./newProject";
import { clone } from "./clone";
import { batch } from "./batch";
import { products } from "./products";
import { settings } from "./settings";
import { generationSettings } from "./generationSettings";
import { showcase } from "./showcase";
import { script } from "./script";
import { assets } from "./assets";
import { video } from "./video";
import { exportPage } from "./exportPage";
import { projectsPage } from "./projectsPage";
import { presenters } from "./presenters";
import { mediaLab } from "./mediaLab";
import { production } from "./production";
import { transcript } from "./transcript";
import { materials } from "./materials";
import { assetLibrary } from "./assetLibrary";
import { apiLog } from "./apiLog";
import { referenceAnalysis } from "./referenceAnalysis";
import { remake } from "./remake";

// Resolve imported bindings on access so HMR cannot pin an earlier namespace export.
const namespaces = {
  common: () => common,
  home: () => home,
  start: () => start,
  topic: () => topic,
  newProject: () => newProject,
  clone: () => clone,
  batch: () => batch,
  products: () => products,
  settings: () => settings,
  generationSettings: () => generationSettings,
  showcase: () => showcase,
  script: () => script,
  assets: () => assets,
  video: () => video,
  exportPage: () => exportPage,
  projectsPage: () => projectsPage,
  presenters: () => presenters,
  mediaLab: () => mediaLab,
  production: () => production,
  transcript: () => transcript,
  materials: () => materials,
  assetLibrary: () => assetLibrary,
  apiLog: () => apiLog,
  referenceAnalysis: () => referenceAnalysis,
  remake: () => remake,
};

/** messages[locale][namespace][key] = 翻译文本 */
function messagesFor(locale: Locale): Record<string, Record<string, string>> {
  // Copying load()[locale] here would retain the old dictionary after a translation-only
  // refresh. Enumerable getters keep both SSR and the browser on the current module value.
  return Object.defineProperties({}, Object.fromEntries(
    Object.entries(namespaces).map(([namespace, load]) => [namespace, {
      enumerable: true,
      get: () => load()[locale],
    }]),
  ));
}

export const messages: Record<Locale, Record<string, Record<string, string>>> = {
  zh: messagesFor("zh"),
  en: messagesFor("en"),
};
