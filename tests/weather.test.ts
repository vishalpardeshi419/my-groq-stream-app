import assert from "node:assert/strict";
import test from "node:test";
import { fetchCurrentWeather } from "../lib/weather";

const validWeatherResponse = {
  name: "Pune",
  main: { temp: 31.4, humidity: 42 },
  weather: [{ description: "clear sky" }],
  wind: { speed: 2.5 },
  sys: { country: "IN" },
};

test("returns current weather for a valid provider response", async () => {
  const result = await fetchCurrentWeather({
    location: "Pune, IN",
    units: "metric",
    apiKey: "test-key",
    fetcher: async () => Response.json(validWeatherResponse),
  });

  assert.deepEqual(result, {
    ok: true,
    location: "Pune, IN",
    temperature: 31.4,
    temperatureUnit: "C",
    description: "clear sky",
    humidityPercent: 42,
    windSpeed: 2.5,
    windSpeedUnit: "m/s",
  });
});

test("returns a result error for an unknown or misspelled city", async () => {
  const result = await fetchCurrentWeather({
    location: "Puuune, IN",
    units: "metric",
    apiKey: "test-key",
    fetcher: async () => new Response(null, { status: 404 }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "location-not-found");
});

test("returns a result error when the API key is missing", async () => {
  const result = await fetchCurrentWeather({
    location: "Pune, IN",
    units: "metric",
    apiKey: null,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "not-configured");
});

test("returns a result error when OpenWeather rejects the key", async () => {
  const result = await fetchCurrentWeather({
    location: "Pune, IN",
    units: "metric",
    apiKey: "invalid-key",
    fetcher: async () => new Response(null, { status: 401 }),
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "invalid-api-key");
});

test("returns a timeout result instead of throwing", async () => {
  const timeoutError = Object.assign(new Error("Timed out"), {
    name: "TimeoutError",
  });
  const result = await fetchCurrentWeather({
    location: "Pune, IN",
    units: "metric",
    apiKey: "test-key",
    fetcher: async () => {
      throw timeoutError;
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "timeout");
});

test("returns a service error instead of throwing on network failure", async () => {
  const result = await fetchCurrentWeather({
    location: "Pune, IN",
    units: "metric",
    apiKey: "test-key",
    fetcher: async () => {
      throw new TypeError("Network unavailable");
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "unavailable");
});
