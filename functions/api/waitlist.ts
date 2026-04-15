/**
 * Cloudflare Pages Function: Happy Class Waitlist
 *
 * Validates Cloudflare Turnstile token, then posts to Notion database.
 *
 * Environment variables (set in Cloudflare Pages dashboard):
 *   TURNSTILE_SECRET_KEY  — Cloudflare Turnstile secret key
 *   NOTION_API_KEY        — Notion integration token
 *   NOTION_DATABASE_ID    — Notion database ID for waitlist
 */

interface Env {
  TURNSTILE_SECRET_KEY: string;
  NOTION_API_KEY: string;
  NOTION_DATABASE_ID: string;
}

interface WaitlistPayload {
  name: string;
  email: string;
  token: string;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  let body: WaitlistPayload;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { name, email, token } = body;

  if (!email || !token) {
    return new Response(JSON.stringify({ error: 'Email is required.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify Turnstile
  const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: request.headers.get('CF-Connecting-IP') || '',
    }),
  });

  const turnstileData = await turnstileRes.json() as { success: boolean };

  if (!turnstileData.success) {
    return new Response(JSON.stringify({ error: 'Verification failed. Please try again.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Post to Notion
  try {
    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_DATABASE_ID },
        properties: {
          Email: {
            title: [{ text: { content: email } }],
          },
          ...(name && {
            Name: {
              rich_text: [{ text: { content: name } }],
            },
          }),
          'Submitted At': {
            date: { start: new Date().toISOString() },
          },
          Source: {
            select: { name: 'thehappyclass.com' },
          },
        },
      }),
    });

    if (!notionRes.ok) {
      console.error('Notion error:', await notionRes.text());
      return new Response(JSON.stringify({ error: 'Failed to submit. Please try again.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Waitlist error:', err);
    return new Response(JSON.stringify({ error: 'Server error. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
