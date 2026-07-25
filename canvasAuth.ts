import { BrowserContext, Cookie, Page, chromium } from "playwright";
import fetch from "node-fetch";
import path from "path";

export interface CanvasSession {
  // Full value for the Cookie request header (all cookies for the Canvas origin).
  cookie: string;
  // Decoded _csrf_token cookie, sent as the X-CSRF-Token header on mutating requests.
  csrfToken: string;
}

const CANVAS_BASE = "https://franklin.instructure.com";
// Persistent browser profile so the login (and 2FA) survives across runs.
const PROFILE_DIR = path.resolve(".canvas-browser-profile");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Returns a valid Canvas session, reusing the saved browser profile when possible.
// Only opens a visible browser when the saved session is missing or expired.
export async function ensureCanvasSession(): Promise<CanvasSession> {
  // First try silently: reuse the saved profile without showing a window.
  let context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
  try {
    const session = await sessionFromContext(context);
    if (session && (await isValid(session))) {
      return session;
    }
  } finally {
    await context.close();
  }

  // Saved session is gone or expired - open a real window so the user can log in.
  console.log("Canvas login required - opening a browser. Log in (and clear 2FA) to continue...");
  context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${CANVAS_BASE}/`);
    const session = await waitForLogin(context, page);
    console.log("Canvas login detected.");
    return session;
  } finally {
    await context.close();
  }
}

// Polls until the browser holds a working Canvas session, then returns it.
async function waitForLogin(context: BrowserContext, page: Page): Promise<CanvasSession> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await sessionFromContext(context);
    if (session && (await isValid(session))) {
      return session;
    }
    await page.waitForTimeout(2000);
  }
  throw new Error("Timed out waiting for Canvas login.");
}

// Builds a CanvasSession from the browser's cookies, or undefined if not logged in.
async function sessionFromContext(context: BrowserContext): Promise<CanvasSession | undefined> {
  const cookies = await context.cookies(CANVAS_BASE);
  const sessionCookie = cookies.find((c: Cookie) => c.name === "canvas_session");
  if (!sessionCookie) {
    return undefined;
  }
  const csrfCookie = cookies.find((c: Cookie) => c.name === "_csrf_token");
  const cookie = cookies.map((c: Cookie) => `${c.name}=${c.value}`).join("; ");
  const csrfToken = csrfCookie ? decodeURIComponent(csrfCookie.value) : "";
  return { cookie, csrfToken };
}

// Confirms the session actually works by calling a lightweight authenticated endpoint.
async function isValid(session: CanvasSession): Promise<boolean> {
  try {
    const resp = await fetch(`${CANVAS_BASE}/api/v1/users/self`, {
      headers: { Cookie: session.cookie },
    });
    return resp.ok;
  } catch {
    return false;
  }
}
