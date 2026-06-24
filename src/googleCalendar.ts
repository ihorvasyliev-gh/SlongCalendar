export interface GoogleBusySlot {
  start: string;
  end: string;
}

interface GoogleOAuthResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

// Module-level cache for the access token to reuse across requests in the same isolate
let cachedAccessToken: string | null = null;
let cachedTokenExpiryTime: number = 0; // Epoch timestamp in ms

export class GoogleCalendarClient {
  private clientEmail: string;
  private privateKey: string;
  private calendarId: string;

  constructor(clientEmail: string, privateKey: string, calendarId: string = 'primary') {
    this.clientEmail = clientEmail;
    this.privateKey = privateKey;
    this.calendarId = calendarId;
  }

  /**
   * Helper to convert base64 to ArrayBuffer
   */
  private base64ToArrayBuffer(b64: string): ArrayBuffer {
    const binaryString = atob(b64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Helper to base64url encode an ArrayBuffer
   */
  private base64UrlEncodeFromBuffer(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary)
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }

  /**
   * Helper to base64url encode a string
   */
  private base64UrlEncode(str: string): string {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    return this.base64UrlEncodeFromBuffer(bytes.buffer);
  }

  /**
   * Generates a signed JWT for Google Service Account authentication
   */
  private async generateJWT(): Promise<string> {
    // Format private key correctly (replace literal \n if stored as env secret)
    const cleanKey = this.privateKey
      .replace(/\\n/g, '\n')
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s+/g, "");

    const binaryKey = this.base64ToArrayBuffer(cleanKey);
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryKey,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: { name: "SHA-256" },
      },
      false,
      ["sign"]
    );

    const header = {
      alg: "RS256",
      typ: "JWT",
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: this.clientEmail,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    };

    const encodedHeader = this.base64UrlEncode(JSON.stringify(header));
    const encodedPayload = this.base64UrlEncode(JSON.stringify(payload));
    const dataToSign = `${encodedHeader}.${encodedPayload}`;

    const encoder = new TextEncoder();
    const signatureBuffer = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      encoder.encode(dataToSign)
    );

    const signature = this.base64UrlEncodeFromBuffer(signatureBuffer);
    return `${dataToSign}.${signature}`;
  }

  /**
   * Fetches (or returns cached) Google Access Token
   */
  async getAccessToken(): Promise<string> {
    const now = Date.now();
    // Use cached token if valid (with 2-minute buffer)
    if (cachedAccessToken && now < cachedTokenExpiryTime - 120000) {
      return cachedAccessToken;
    }

    const jwt = await this.generateJWT();
    
    const tokenUrl = "https://oauth2.googleapis.com/token";
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    });

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google OAuth failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json() as GoogleOAuthResponse;
    cachedAccessToken = data.access_token;
    cachedTokenExpiryTime = Date.now() + (data.expires_in * 1000);

    return cachedAccessToken;
  }

  /**
   * Fetches busy slots for the calendar within a specific timeframe
   */
  async getBusySlots(timeMin: string, timeMax: string): Promise<GoogleBusySlot[]> {
    const accessToken = await this.getAccessToken();
    const url = "https://www.googleapis.com/calendar/v3/freeBusy";

    const body = {
      timeMin,
      timeMax,
      items: [{ id: this.calendarId }],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google FreeBusy API failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json() as {
      calendars: {
        [key: string]: {
          busy: GoogleBusySlot[];
        };
      };
    };

    const calData = data.calendars[this.calendarId];
    return calData ? calData.busy : [];
  }

  /**
   * Creates a calendar event for a confirmed booking
   */
  async createEvent(event: {
    summary: string;
    description: string;
    startTime: string;
    endTime: string;
  }): Promise<{ id: string; htmlLink?: string }> {
    const accessToken = await this.getAccessToken();
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`;

    const body = {
      summary: event.summary,
      description: event.description,
      start: {
        dateTime: event.startTime,
      },
      end: {
        dateTime: event.endTime,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Create Event API failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    return response.json() as Promise<{ id: string; htmlLink?: string }>;
  }
}
