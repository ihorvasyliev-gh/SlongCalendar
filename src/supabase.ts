export interface BookingToken {
  id: string;
  token: string;
  sender_id: string;
  platform: 'facebook' | 'instagram';
  used: boolean;
  expires_at: string;
  created_at: string;
}

export interface Appointment {
  id: string;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  start_time: string;
  end_time: string;
  status: 'confirmed' | 'cancelled';
  token_id: string | null;
  google_event_id: string | null;
  created_at: string;
}

export class SupabaseClient {
  private url: string;
  private key: string;

  constructor(url: string, key: string) {
    // Remove trailing slash if present
    this.url = url.replace(/\/$/, '');
    this.key = key;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set('apikey', this.key);
    headers.set('Authorization', `Bearer ${this.key}`);
    headers.set('Content-Type', 'application/json');

    const response = await fetch(`${this.url}/rest/v1${path}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    // PostgREST return representation can be empty for some commands
    if (response.status === 204) {
      return {} as T;
    }

    return response.json();
  }

  /**
   * Generates a new booking token and saves it.
   */
  async createBookingToken(senderId: string, platform: 'facebook' | 'instagram', durationHours: number = 24): Promise<BookingToken> {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + durationHours);

    const body = {
      sender_id: senderId,
      platform,
      expires_at: expiresAt.toISOString(),
      used: false,
    };

    // Prefer return=representation to get the inserted object
    const result = await this.request<BookingToken[]>('/booking_tokens', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Prefer': 'return=representation',
      },
    });

    if (!result || result.length === 0) {
      throw new Error('Failed to create booking token');
    }

    return result[0];
  }

  /**
   * Validates a token. Returns the token object if valid, otherwise null.
   */
  async validateBookingToken(tokenStr: string): Promise<BookingToken | null> {
    const nowStr = new Date().toISOString();
    
    // Query token that is not used and not expired
    const path = `/booking_tokens?token=eq.${encodeURIComponent(tokenStr)}&used=eq.false&expires_at=gt.${encodeURIComponent(nowStr)}`;
    
    const result = await this.request<BookingToken[]>(path, {
      method: 'GET',
    });

    if (!result || result.length === 0) {
      return null;
    }

    return result[0];
  }

  /**
   * Marks a token as used.
   */
  async markTokenAsUsed(tokenId: string): Promise<void> {
    await this.request(`/booking_tokens?id=eq.${encodeURIComponent(tokenId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ used: true }),
    });
  }

  /**
   * Creates a new appointment.
   */
  async createAppointment(appointment: {
    client_name: string;
    client_email: string;
    client_phone?: string;
    start_time: string;
    end_time: string;
    token_id: string;
    google_event_id?: string;
  }): Promise<Appointment> {
    const result = await this.request<Appointment[]>('/appointments', {
      method: 'POST',
      body: JSON.stringify({
        client_name: appointment.client_name,
        client_email: appointment.client_email,
        client_phone: appointment.client_phone || null,
        start_time: appointment.start_time,
        end_time: appointment.end_time,
        status: 'confirmed',
        token_id: appointment.token_id,
        google_event_id: appointment.google_event_id || null,
      }),
      headers: {
        'Prefer': 'return=representation',
      },
    });

    if (!result || result.length === 0) {
      throw new Error('Failed to create appointment');
    }

    return result[0];
  }

  /**
   * Retrieves active (confirmed) appointments for a specific time range to prevent double-booking.
   */
  async getBookedAppointments(startRange: string, endRange: string): Promise<Appointment[]> {
    const path = `/appointments?status=eq.confirmed&start_time=lt.${encodeURIComponent(endRange)}&end_time=gt.${encodeURIComponent(startRange)}`;
    return this.request<Appointment[]>(path, {
      method: 'GET',
    });
  }
}
