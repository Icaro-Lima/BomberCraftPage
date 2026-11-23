export function defaultServer({ hostname, search }, native = false) {
  return new URLSearchParams(search).get("server") ??
    (!native && ["localhost", "127.0.0.1"].includes(hostname)
      ? "http://127.0.0.1:2567"
      : "https://vps73608.publiccloud.com.br");
}
