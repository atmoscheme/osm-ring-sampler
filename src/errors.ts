export class OsmSamplerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class OsmConfigError extends OsmSamplerError {}

export class InvalidCoordinatesError extends OsmSamplerError {
  readonly lat: number;
  readonly lon: number;

  constructor(lat: number, lon: number, message?: string) {
    super(
      message ??
        `Invalid geographic coordinates: lat=${String(lat)}, lon=${String(lon)}. Expected finite lat in [-90, 90] and lon in [-180, 180].`,
    );
    this.lat = lat;
    this.lon = lon;
  }
}

export class OsmUpstreamError extends OsmSamplerError {
  readonly status?: number;
  readonly endpoint?: string;

  constructor(
    message: string,
    details?: { status?: number; endpoint?: string; cause?: unknown },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.status = details?.status;
    this.endpoint = details?.endpoint;
  }
}

export class OsmTimeoutError extends OsmUpstreamError {
  readonly timeoutMs: number;

  constructor(endpoint: string, timeoutMs: number, cause?: unknown) {
    super(`Upstream request to ${endpoint} timed out after ${timeoutMs}ms`, {
      endpoint,
      cause,
    });
    this.timeoutMs = timeoutMs;
  }
}

export class ThinSampleError extends OsmSamplerError {
  readonly foundCount: number;
  readonly requiredCount: number;

  constructor(foundCount: number, requiredCount: number) {
    super(
      `Nearby sample is too sparse: found ${foundCount} named OSM place(s), expected at least ${requiredCount}.`,
    );
    this.foundCount = foundCount;
    this.requiredCount = requiredCount;
  }
}
