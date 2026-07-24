module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function getBackendBaseUrl() {
  return (process.env.BACKEND_URL || process.env.REACT_APP_BACKEND_URL || "").trim().replace(/\/+$/, "");
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function buildUpstreamUrl(req, backendBaseUrl) {
  const pathParts = Array.isArray(req.query.path)
    ? req.query.path
    : req.query.path
      ? [req.query.path]
      : [];

  const upstream = new URL(`${backendBaseUrl}/api/${pathParts.map(encodeURIComponent).join("/")}`);
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    if (Array.isArray(value)) {
      for (const item of value) upstream.searchParams.append(key, item);
    } else if (value != null) {
      upstream.searchParams.append(key, value);
    }
  }
  return upstream;
}

function copyResponseHeaders(upstreamResponse, res) {
  upstreamResponse.headers.forEach((value, key) => {
    const lowered = key.toLowerCase();
    if (lowered === "content-length" || lowered === "transfer-encoding" || lowered === "content-encoding") {
      return;
    }
    res.setHeader(key, value);
  });
}

module.exports = async function handler(req, res) {
  const backendBaseUrl = getBackendBaseUrl();
  if (!backendBaseUrl) {
    return res.status(500).json({ detail: "Backend URL is not configured." });
  }

  const upstreamUrl = buildUpstreamUrl(req, backendBaseUrl);
  const headers = new Headers();

  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    const lowered = key.toLowerCase();
    if (lowered === "host" || lowered === "connection" || lowered === "content-length") continue;
    headers.set(key, Array.isArray(value) ? value.join(",") : value);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await readRawBody(req) : undefined;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    copyResponseHeaders(upstreamResponse, res);
    const payload = Buffer.from(await upstreamResponse.arrayBuffer());
    return res.status(upstreamResponse.status).send(payload);
  } catch (error) {
    return res.status(502).json({
      detail: "Unable to reach backend service.",
      error: error instanceof Error ? error.message : "Unknown proxy error",
    });
  }
};
