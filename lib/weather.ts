import { z } from "zod";

const weatherResponseSchema = z.object({
  name: z.string(),
  main: z.object({ temp: z.number(), humidity: z.number() }),
  weather: z.array(z.object({ description: z.string() })).min(1),
  wind: z.object({ speed: z.number() }).optional(),
  sys: z.object({ country: z.string().optional() }).optional(),
});

export type WeatherUnits = "metric" | "imperial";

export type WeatherResult =
  | {
      ok: true;
      location: string;
      temperature: number;
      temperatureUnit: "C" | "F";
      description: string;
      humidityPercent: number;
      windSpeed: number | null;
      windSpeedUnit: "m/s" | "mph";
    }
  | {
      ok: false;
      code:
        | "not-configured"
        | "location-not-found"
        | "invalid-api-key"
        | "http-error"
        | "invalid-response"
        | "timeout"
        | "cancelled"
        | "unavailable";
      error: string;
    };

export async function fetchCurrentWeather({
  location,
  units,
  apiKey,
  signal,
  fetcher = fetch,
}: {
  location: string;
  units: WeatherUnits;
  apiKey?: string | null;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<WeatherResult> {
  const configuredApiKey =
    apiKey === undefined ? process.env.OPENWEATHER_API_KEY : apiKey;

  if (!configuredApiKey) {
    return {
      ok: false,
      code: "not-configured",
      error: "Weather lookup is not configured. Add OPENWEATHER_API_KEY on the server.",
    };
  }

  const params = new URLSearchParams({
    q: location,
    appid: configuredApiKey,
    units,
  });

  try {
    const timeoutSignal = AbortSignal.timeout(8_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    const response = await fetcher(
      `https://api.openweathermap.org/data/2.5/weather?${params}`,
      { cache: "no-store", signal: requestSignal },
    );

    if (!response.ok) {
      if (response.status === 404) {
        return {
          ok: false,
          code: "location-not-found",
          error: "Location not found. Provide a city name and optionally a country code.",
        };
      }
      if (response.status === 401) {
        return {
          ok: false,
          code: "invalid-api-key",
          error: "The weather service rejected its server credentials.",
        };
      }
      return {
        ok: false,
        code: "http-error",
        error: `The weather service returned status ${response.status}.`,
      };
    }

    const parsed = weatherResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return {
        ok: false,
        code: "invalid-response",
        error: "The weather service returned an unexpected response.",
      };
    }

    const weather = parsed.data;
    return {
      ok: true,
      location: [weather.name, weather.sys?.country].filter(Boolean).join(", "),
      temperature: weather.main.temp,
      temperatureUnit: units === "metric" ? "C" : "F",
      description: weather.weather[0].description,
      humidityPercent: weather.main.humidity,
      windSpeed: weather.wind?.speed ?? null,
      windSpeedUnit: units === "metric" ? "m/s" : "mph",
    };
  } catch (error) {
    if (signal?.aborted) {
      return {
        ok: false,
        code: "cancelled",
        error: "The weather lookup was cancelled.",
      };
    }

    if (error instanceof Error && error.name === "TimeoutError") {
      return {
        ok: false,
        code: "timeout",
        error: "The weather lookup timed out. Try again later.",
      };
    }

    return {
      ok: false,
      code: "unavailable",
      error: "The weather service could not be reached. Try again later.",
    };
  }
}
