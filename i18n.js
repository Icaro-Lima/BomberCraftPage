import { catalogs } from "./translations.js";

const storageKey = "bombercraft.language";
const listeners = new Set();
const attributes = ["aria-label", "aria-valuetext", "title", "placeholder", "alt", "content"];
const preferredLanguages = () => globalThis.navigator?.languages?.length
  ? navigator.languages : [globalThis.navigator?.language ?? "en"];

export function resolveLanguage(preference, languages = []) {
  if (Object.hasOwn(catalogs, preference)) return preference;
  for (const language of languages) {
    const base = String(language).toLowerCase().split(/[-_]/)[0];
    if (base === "pt") return "pt-BR";
    if (base === "en") return "en";
  }
  return "en";
}

let preference = "";
try {
  const saved = globalThis.localStorage?.getItem(storageKey);
  if (Object.hasOwn(catalogs, saved)) preference = saved;
} catch { /* Language detection still works without browser storage. */ }
let language = resolveLanguage(preference, preferredLanguages());

export const getLanguage = () => language;
export const getLanguagePreference = () => preference;

export function t(message, values = {}) {
  const translated = Object.hasOwn(catalogs[language], message) ? catalogs[language][message] : message;
  return translated.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

export function refreshDetectedLanguage() {
  const next = resolveLanguage(preference, preferredLanguages());
  if (next === language) return;
  language = next;
  for (const callback of listeners) callback();
}

export function setLanguagePreference(value) {
  if (value !== "" && !Object.hasOwn(catalogs, value)) throw new Error("Unsupported language preference");
  preference = value;
  try {
    if (value) globalThis.localStorage?.setItem(storageKey, value);
    else globalThis.localStorage?.removeItem(storageKey);
  } catch { /* A manual choice still applies to this session. */ }
  language = resolveLanguage(preference, preferredLanguages());
  for (const callback of listeners) callback();
}

export function onLanguageChange(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function renderElement(node) {
  const values = JSON.parse(node.getAttribute("data-i18n-values") ?? "{}");
  if (node.hasAttribute("data-i18n")) {
    const value = t(node.getAttribute("data-i18n"), values);
    if (node.textContent !== value) node.textContent = value;
  }
  for (const attribute of attributes) {
    const message = node.getAttribute(`data-i18n-${attribute}`);
    if (message !== null) {
      const value = t(message, values);
      if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
    }
  }
}

export function localizedText(node, message, values = {}) {
  const encoded = JSON.stringify(values);
  if (node.getAttribute("data-i18n") === message && node.getAttribute("data-i18n-values") === encoded) return;
  node.setAttribute("data-i18n", message);
  node.setAttribute("data-i18n-values", encoded);
  renderElement(node);
}

export function localizedAttribute(node, attribute, message, values = {}) {
  node.setAttribute(`data-i18n-${attribute}`, message);
  node.setAttribute("data-i18n-values", JSON.stringify(values));
  renderElement(node);
}

export function wireLanguageSettings() {
  const select = document.getElementById("language-select");
  function render() {
    document.documentElement.lang = language;
    const selector = ["[data-i18n]", ...attributes.map((attribute) => `[data-i18n-${attribute}]`)].join(",");
    for (const node of document.querySelectorAll(selector)) renderElement(node);
    select.value = preference;
  }
  select.addEventListener("change", () => setLanguagePreference(select.value));
  window.addEventListener("languagechange", refreshDetectedLanguage);
  window.addEventListener("focus", refreshDetectedLanguage);
  onLanguageChange(render);
  render();
}
