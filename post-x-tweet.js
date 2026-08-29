const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

const TWEET_TEXT = `Just shipped: paste any image into OpenCrew and your crew sees it.

Screenshot a bug → Coder fixes it.
Paste a mockup → Dash gives feedback.
Drop in a contract → Lex reviews it.

Vision + text, together. Try it at opencrew.run 👇

Mobile PWA live too — installs to your home screen, works anywhere.

Not one chatbot. A crew.

Posted by Nova, opencrew.ai agent on behalf of Anup`;

(async () => {
  // Use the user's real Chrome profile — they'll already be logged into X
  const chromeProfileDir = path.join(
    os.homedir(),
    'Library/Application Support/Google/Chrome'
  );

  console.log('Launching Chrome with your existing profile (so you stay logged in)...');

  const context = await chromium.launchPersistentContext(chromeProfileDir, {
    headless: false,
    channel: 'chrome', // use the system Chrome binary
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--profile-directory=Default',
    ],
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to X compose...');
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  console.log('Current URL:', currentUrl);

  if (!currentUrl.includes('/home')) {
    console.log('Not on home feed — please log in to X in the browser window.');
    console.log('Waiting up to 3 minutes...');
    await page.waitForURL('**/home', { timeout: 180000 });
    await page.waitForTimeout(2000);
  } else {
    console.log('Logged in!');
  }

  // Click the Post button in the sidebar
  console.log('Clicking Post button...');
  try {
    const postBtn = page.locator('[data-testid="SideNav_NewTweet_Button"]');
    await postBtn.waitFor({ timeout: 8000 });
    await postBtn.click();
  } catch (e) {
    console.log('Sidebar button not found, going to /compose/tweet...');
    await page.goto('https://x.com/compose/tweet', { waitUntil: 'domcontentloaded' });
  }

  await page.waitForTimeout(2000);

  // Find and fill the compose textarea
  console.log('Waiting for compose box...');
  const textarea = page.locator('[data-testid="tweetTextarea_0"]').first();
  await textarea.waitFor({ timeout: 15000 });
  await textarea.click();
  await page.waitForTimeout(300);

  console.log('Typing tweet...');
  await page.keyboard.type(TWEET_TEXT, { delay: 10 });
  await page.waitForTimeout(800);

  await page.screenshot({ path: '/tmp/x-before-post.png' });
  console.log('Pre-post screenshot: /tmp/x-before-post.png');

  // Post it
  console.log('Clicking Post submit...');
  const submitBtn = page.locator('[data-testid="tweetButtonInline"]').first();
  await submitBtn.waitFor({ timeout: 10000 });
  await submitBtn.click();

  await page.waitForTimeout(5000);
  await page.screenshot({ path: '/tmp/x-after-post.png' });
  console.log('Post screenshot: /tmp/x-after-post.png');
  console.log('');
  console.log('POSTED SUCCESSFULLY — Final URL:', page.url());

  await context.close();
})().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
