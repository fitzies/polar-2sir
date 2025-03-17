import { Elysia } from "elysia";
import { createClient } from "redis";

// Configuration
const CLIENT_ID = process.env.CLIENT_ID!; // Your Polar client ID
const CLIENT_SECRET = process.env.CLIENT_SECRET!; // Your Polar client secret
const REDIRECT_URI = "http://localhost:3000/auth/callback"; // Must be registered in Polar admin
const AUTHORIZATION_ENDPOINT = "https://flow.polar.com/oauth2/authorization";
const TOKEN_ENDPOINT = "https://polarremote.com/v2/oauth2/token"; // Updated token endpoint
const REGISTER_USER_ENDPOINT = "https://www.polaraccesslink.com/v3/users";
const PHYSICAL_INFO_ENDPOINT = "https://www.polaraccesslink.com/v3/users";

// Redis Client Setup
const redisClient = createClient({
  url: "redis://default:auCDDzFHZmIKIyERoOEFxaFoVviPcspK@shinkansen.proxy.rlwy.net:51616",
});
redisClient.on("error", (err) => console.log("Redis Client Error", err));

// Connect to Redis
await redisClient.connect();

// Redis utility functions
const setValue = async (
  key: string,
  value: string,
  expiresIn?: number
): Promise<void> => {
  if (expiresIn) {
    await redisClient.setEx(key, expiresIn, value);
  } else {
    await redisClient.set(key, value);
  }
};
const getValue = async (key: string): Promise<string | null> => {
  return redisClient.get(key);
};

// Initialize Elysia app
const app = new Elysia();

// Step 1: Redirect user to Polar Flow
app.get("/auth/login", ({ redirect, query }) => {
  const authUrl = new URL(AUTHORIZATION_ENDPOINT);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  const state = query.state || "default";
  authUrl.searchParams.set("state", state);

  return redirect(authUrl.toString());
});

// Step 2: Handle callback, exchange code, store token, and register user
app.get("/auth/callback", async ({ query, set }) => {
  const { code, error, state } = query;

  if (error) {
    set.status = 400;
    return `Error: ${error}`;
  }

  if (!code) {
    set.status = 400;
    return "No authorization code received";
  }

  try {
    const authHeader = `Basic ${Buffer.from(
      `${CLIENT_ID}:${CLIENT_SECRET}`
    ).toString("base64")}`;
    const tokenResponse = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        Authorization: authHeader,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code as string,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      throw new Error(
        `Token exchange failed: ${tokenResponse.status} - ${errorText}`
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const userId = tokenData.x_user_id;

    if (!userId) {
      set.status = 500;
      return "Error: No x_user_id in token response";
    }

    const tokenKey = `polar_access_token:${userId}`;
    await setValue(tokenKey, accessToken, tokenData.expires_in);

    const registerResponse = await fetch(REGISTER_USER_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        "member-id": userId,
      }),
    });

    if (!registerResponse.ok && registerResponse.status !== 409) {
      const errorText = await registerResponse.text();
      throw new Error(
        `User registration failed: ${registerResponse.status} - ${errorText}`
      );
    }

    return `Success! User ${userId} registered. Access Token: ${accessToken}`;
  } catch (err) {
    set.status = 500;
    return `Error: ${err.message}`;
  }
});

// Step 3: Fetch user's physical information
app.get("/user/physical-info", async ({ query, set }) => {
  const { userId } = query;

  if (!userId) {
    set.status = 400;
    return "User ID is required (e.g., /user/physical-info?userId=123)";
  }

  try {
    const tokenKey = `polar_access_token:${userId}`;
    const accessToken = await getValue(tokenKey);

    if (!accessToken) {
      set.status = 400;
      return `No access token found for user ${userId}`;
    }

    const response = await fetch(
      `${PHYSICAL_INFO_ENDPOINT}/${userId}/physical-information`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Physical info fetch failed: ${response.status} - ${errorText}`
      );
    }

    const physicalInfo = await response.json();
    return `Physical Info for user ${userId}: ${JSON.stringify(physicalInfo)}`;
  } catch (err) {
    set.status = 500;
    return `Error: ${err.message}`;
  }
});

// Start server
app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
