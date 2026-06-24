import { SupabaseClient } from './supabase';
import { GoogleCalendarClient } from './googleCalendar';

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  
  META_VERIFY_TOKEN: string;
  META_PAGE_ACCESS_TOKEN: string;
  META_APP_SECRET?: string; // Optional, but recommended for webhook signature verification
  
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
  GOOGLE_CALENDAR_ID: string;

  BUSINESS_TIMEZONE?: string; // Default: 'UTC'
  BUSINESS_START_HOUR?: string; // Default: '9'
  BUSINESS_END_HOUR?: string; // Default: '17'
  SLOT_DURATION_MINS?: string; // Default: '60'
  SLOT_BUFFER_MINS?: string; // Default: '0'
  BOOKING_URL: string; // Base URL of SPA, e.g. 'https://susan-booking.pages.dev'
}

// CORS helper headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // Routing
    if (url.pathname === '/webhook') {
      if (request.method === 'GET') {
        return handleWebhookVerification(request, env);
      } else if (request.method === 'POST') {
        return handleWebhookEvent(request, env);
      }
    } else if (url.pathname === '/api/validate-token' && request.method === 'GET') {
      return handleValidateToken(request, env);
    } else if (url.pathname === '/api/available-slots' && request.method === 'GET') {
      return handleAvailableSlots(request, env);
    } else if (url.pathname === '/api/book' && request.method === 'POST') {
      return handleBook(request, env);
    }

    return new Response('Not Found', { status: 404 });
  }
};

/**
 * GET /webhook
 * Meta Webhook Verification (hub.mode, hub.verify_token, hub.challenge)
 */
async function handleWebhookVerification(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
    console.log('Webhook verified successfully.');
    return new Response(challenge, { status: 200 });
  }

  return new Response('Forbidden', { status: 403 });
}

/**
 * POST /webhook
 * Receives messages from FB Messenger / IG Direct.
 * Generates a one-time booking link and replies via Meta Send API.
 */
async function handleWebhookEvent(request: Request, env: Env): Promise<Response> {
  const rawBody = await request.text();

  // Verify HMAC signature if app secret is provided
  if (env.META_APP_SECRET) {
    const verified = await verifyMetaSignature(request, rawBody, env.META_APP_SECRET);
    if (!verified) {
      console.error('Webhook signature verification failed');
      return new Response('Unauthorized', { status: 401 });
    }
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (err) {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Check if this is a page subscription webhook
  if (body.object === 'page' || body.object === 'instagram') {
    const platform = body.object === 'instagram' ? 'instagram' : 'facebook';
    const entries = body.entry || [];

    for (const entry of entries) {
      const messaging = entry.messaging || [];
      for (const messageEvent of messaging) {
        // Only respond to text messages (ignore echo events, deliveries, read receipts)
        if (messageEvent.message && messageEvent.message.text && !messageEvent.message.is_echo) {
          const senderId = messageEvent.sender.id;
          
          // Execute background task to reply to the user without blocking the webhook response
          const supabase = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
          
          try {
            // Generate booking token in Supabase
            const tokenRow = await supabase.createBookingToken(senderId, platform);
            
            // Send Meta response
            await sendMetaBookingLink(senderId, tokenRow.token, platform, env);
          } catch (err) {
            console.error('Error handling messaging event:', err);
          }
        }
      }
    }
    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  return new Response('Not Found', { status: 404 });
}

/**
 * GET /api/validate-token?token=XYZ
 */
async function handleValidateToken(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (!token) {
    return new Response(JSON.stringify({ error: 'Token parameter is required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabase = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  
  try {
    const tokenRow = await supabase.validateBookingToken(token);
    if (!tokenRow) {
      return new Response(JSON.stringify({ valid: false }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ valid: true, platform: tokenRow.platform }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

/**
 * GET /api/available-slots?token=XYZ&date=YYYY-MM-DD
 */
async function handleAvailableSlots(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const dateStr = url.searchParams.get('date'); // YYYY-MM-DD

  if (!token || !dateStr) {
    return new Response(JSON.stringify({ error: 'Token and date parameters are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  // Validate YYYY-MM-DD format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return new Response(JSON.stringify({ error: 'Invalid date format. Use YYYY-MM-DD' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabase = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  
  try {
    // 1. Validate token
    const tokenRow = await supabase.validateBookingToken(token);
    if (!tokenRow) {
      return new Response(JSON.stringify({ error: 'Invalid or expired booking token' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Setup configuration
    const timezone = env.BUSINESS_TIMEZONE || 'UTC';
    const startHour = parseInt(env.BUSINESS_START_HOUR || '9', 10);
    const endHour = parseInt(env.BUSINESS_END_HOUR || '17', 10);
    const durationMins = parseInt(env.SLOT_DURATION_MINS || '60', 10);
    const bufferMins = parseInt(env.SLOT_BUFFER_MINS || '0', 10);

    // Calculate start/end of the day in UTC to fetch busy schedules
    const dayStartUTC = getUTCDateTime(dateStr, formatTime(startHour, 0), timezone);
    const dayEndUTC = getUTCDateTime(dateStr, formatTime(endHour, 0), timezone);

    // 3. Fetch Google Calendar busy slots
    const gCal = new GoogleCalendarClient(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_CALENDAR_ID
    );
    const busySlots = await gCal.getBusySlots(dayStartUTC.toISOString(), dayEndUTC.toISOString());

    // 4. Fetch Supabase active appointments
    const bookedAppointments = await supabase.getBookedAppointments(dayStartUTC.toISOString(), dayEndUTC.toISOString());

    // 5. Generate potential slots
    const availableSlots: { start: string; end: string }[] = [];
    let currentSlotStart = new Date(dayStartUTC.getTime());

    while (currentSlotStart.getTime() + (durationMins * 60 * 1000) <= dayEndUTC.getTime()) {
      const slotEnd = new Date(currentSlotStart.getTime() + (durationMins * 60 * 1000));
      
      const slotStartISO = currentSlotStart.toISOString();
      const slotEndISO = slotEnd.toISOString();

      // Check if slot overlaps with any Google Calendar busy times
      const overlapsGoogle = busySlots.some(busy => {
        const busyStart = new Date(busy.start).getTime();
        const busyEnd = new Date(busy.end).getTime();
        return (currentSlotStart.getTime() < busyEnd && slotEnd.getTime() > busyStart);
      });

      // Check if slot overlaps with any database appointments
      const overlapsSupabase = bookedAppointments.some(appt => {
        const apptStart = new Date(appt.start_time).getTime();
        const apptEnd = new Date(appt.end_time).getTime();
        return (currentSlotStart.getTime() < apptEnd && slotEnd.getTime() > apptStart);
      });

      // Also ensure we don't display slots in the past
      const isPast = currentSlotStart.getTime() <= Date.now();

      if (!overlapsGoogle && !overlapsSupabase && !isPast) {
        availableSlots.push({
          start: slotStartISO,
          end: slotEndISO,
        });
      }

      // Advance by slot duration + buffer
      currentSlotStart = new Date(currentSlotStart.getTime() + ((durationMins + bufferMins) * 60 * 1000));
    }

    return new Response(JSON.stringify({ slots: availableSlots }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('Error fetching available slots:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

/**
 * POST /api/book
 * Submits the selected slot, validates token, writes to DB and Calendar, consumes token, and sends Meta message.
 */
async function handleBook(request: Request, env: Env): Promise<Response> {
  let body;
  try {
    body = await request.json() as {
      token: string;
      name: string;
      email: string;
      phone?: string;
      slotStart: string; // ISO string
      notes?: string;
      guests?: string[];
    };
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const { token, name, email, phone, slotStart, notes, guests } = body;
  if (!token || !name || !email || !slotStart) {
    return new Response(JSON.stringify({ error: 'Missing required parameters: token, name, email, slotStart' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const supabase = new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // 1. Validate Token (must be unused and active)
    const tokenRow = await supabase.validateBookingToken(token);
    if (!tokenRow) {
      return new Response(JSON.stringify({ error: 'Booking token is invalid, used, or expired' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 2. Re-verify the slot is still free
    const durationMins = parseInt(env.SLOT_DURATION_MINS || '60', 10);
    const slotStartTIme = new Date(slotStart);
    const slotEndTime = new Date(slotStartTIme.getTime() + (durationMins * 60 * 1000));
    const slotEnd = slotEndTime.toISOString();

    const gCal = new GoogleCalendarClient(
      env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      env.GOOGLE_PRIVATE_KEY,
      env.GOOGLE_CALENDAR_ID
    );
    const busySlots = await gCal.getBusySlots(slotStart, slotEnd);
    const overlapsGoogle = busySlots.some(busy => {
      const busyStart = new Date(busy.start).getTime();
      const busyEnd = new Date(busy.end).getTime();
      return (slotStartTIme.getTime() < busyEnd && slotEndTime.getTime() > busyStart);
    });

    const bookedAppointments = await supabase.getBookedAppointments(slotStart, slotEnd);
    const overlapsSupabase = bookedAppointments.some(appt => {
      const apptStart = new Date(appt.start_time).getTime();
      const apptEnd = new Date(appt.end_time).getTime();
      return (slotStartTIme.getTime() < apptEnd && slotEndTime.getTime() > apptStart);
    });

    if (overlapsGoogle || overlapsSupabase) {
      return new Response(JSON.stringify({ error: 'This time slot is no longer available' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 3. Create Google Calendar Event
    const timezone = env.BUSINESS_TIMEZONE || 'UTC';
    const localTimeFormatted = slotStartTIme.toLocaleString('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short'
    });

    let eventDescription = `Client: ${name}\nEmail: ${email}\nPhone: ${phone || 'N/A'}\nPlatform: ${tokenRow.platform}\nMeta User ID: ${tokenRow.sender_id}\nBooking Token: ${token}`;
    if (guests && guests.length > 0) {
      eventDescription += `\nGuests:\n- ${guests.join('\n- ')}`;
    }
    if (notes) {
      eventDescription += `\n\nNotes:\n${notes}`;
    }
    
    const gEvent = await gCal.createEvent({
      summary: `Booking - ${name}`,
      description: eventDescription,
      startTime: slotStart,
      endTime: slotEnd,
    });

    // 4. Save Appointment to Supabase with Google Event ID
    const appointment = await supabase.createAppointment({
      client_name: name,
      client_email: email,
      client_phone: phone,
      start_time: slotStart,
      end_time: slotEnd,
      token_id: tokenRow.id,
      google_event_id: gEvent.id
    });

    // 5. Consume Token
    await supabase.markTokenAsUsed(tokenRow.id);

    // 6. Send message confirmation back to the Meta user
    await sendMetaConfirmation(tokenRow.sender_id, localTimeFormatted, tokenRow.platform, env);

    return new Response(JSON.stringify({ success: true, appointment }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    console.error('Error booking appointment:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Verifies webhook request signatures sent by Meta.
 */
async function verifyMetaSignature(request: Request, rawBody: string, appSecret: string): Promise<boolean> {
  const signatureHeader = request.headers.get('x-hub-signature-256');
  if (!signatureHeader) return false;

  const parts = signatureHeader.split('=');
  if (parts.length !== 2 || parts[0] !== 'sha256') return false;
  const expectedSig = parts[1];

  const encoder = new TextEncoder();
  const keyData = encoder.encode(appSecret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: { name: 'SHA-256' } },
    false,
    ['verify']
  );

  const bodyData = encoder.encode(rawBody);
  
  // Convert hex signature to Uint8Array
  const hexMatch = expectedSig.match(/.{1,2}/g);
  if (!hexMatch) return false;
  const signatureBytes = new Uint8Array(hexMatch.map(byte => parseInt(byte, 16)));

  return crypto.subtle.verify(
    'HMAC',
    cryptoKey,
    signatureBytes,
    bodyData
  );
}

/**
 * Sends a booking button link back to the user on Facebook Messenger or Instagram Direct.
 */
async function sendMetaBookingLink(recipientId: string, token: string, platform: 'facebook' | 'instagram', env: Env): Promise<void> {
  const bookingUrl = `${env.BOOKING_URL.replace(/\/$/, '')}/?token=${token}`;
  
  // Structured Button Template payload (works on FB, and standard IG text link fallback is sent if template errors)
  const payload = {
    recipient: { id: recipientId },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'Hello! Please tap the button below to view available slots and book your appointment:',
          buttons: [
            {
              type: 'web_url',
              url: bookingUrl,
              title: 'Book Appointment',
              webview_height_ratio: 'full'
            }
          ]
        }
      }
    }
  };

  const response = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${env.META_PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Meta Send API failed to send button: ${response.status}. Falling back to plain text link. Error:`, errorText);
    
    // Fallback: Send a plain text message if the page button template fails/isn't supported for this IG Direct thread
    const fallbackPayload = {
      recipient: { id: recipientId },
      message: {
        text: `Hello! Please click the link below to choose your appointment time:\n\n${bookingUrl}`
      }
    };
    
    const fallbackResponse = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${env.META_PAGE_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fallbackPayload),
    });

    if (!fallbackResponse.ok) {
      console.error('Meta Send API plain text fallback also failed:', await fallbackResponse.text());
    }
  }
}

/**
 * Sends a booking confirmation text message back to the Meta user.
 */
async function sendMetaConfirmation(recipientId: string, formattedTime: string, platform: 'facebook' | 'instagram', env: Env): Promise<void> {
  const payload = {
    recipient: { id: recipientId },
    message: {
      text: `🎉 Thank you! Your booking for ${formattedTime} (Business Local Time) has been confirmed successfully! We look forward to seeing you.`
    }
  };

  const response = await fetch(`https://graph.facebook.com/v20.0/me/messages?access_token=${env.META_PAGE_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error('Failed to send booking confirmation to Meta:', await response.text());
  }
}

/**
 * Formats hour/minute to HH:MM format
 */
function formatTime(hour: number, minute: number): string {
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

/**
 * Converts local date and time string in a timezone to a UTC Date object using the Intl API.
 */
function getUTCDateTime(dateStr: string, timeStr: string, timezone: string): Date {
  // Create a base UTC date at the requested time
  const utcDate = new Date(`${dateStr}T${timeStr}:00Z`);
  
  // Format that UTC date in the target timezone to find the difference
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(utcDate);
  const partVal = (type: string) => parts.find(p => p.type === type)!.value;
  
  // Construct formatted local string "YYYY-MM-DDTHH:MM:SSZ"
  const formattedLocal = `${partVal('year')}-${partVal('month')}-${partVal('day')}T${partVal('hour')}:${partVal('minute')}:${partVal('second')}Z`;
  
  const diff = new Date(formattedLocal).getTime() - utcDate.getTime();
  
  // Adjust the original date object by subtracting the difference (offset)
  return new Date(utcDate.getTime() - diff);
}
