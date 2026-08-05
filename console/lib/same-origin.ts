export function assertRequestSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;

  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(request.url);
    const expectedHost = (
      request.headers.get("host") ?? requestUrl.host
    ).toLowerCase();
    const forwardedProtocol = request.headers
      .get("x-forwarded-proto")
      ?.split(",", 1)[0]
      ?.trim()
      .toLowerCase();
    const expectedProtocol = forwardedProtocol
      ? `${forwardedProtocol}:`
      : requestUrl.protocol;
    if (
      originUrl.host.toLowerCase() !== expectedHost ||
      originUrl.protocol !== expectedProtocol
    ) {
      throw new Error("cross_origin");
    }
  } catch {
    throw new Error("cross_origin");
  }
}
