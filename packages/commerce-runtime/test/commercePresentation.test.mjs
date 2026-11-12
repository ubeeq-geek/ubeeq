import test from 'node:test';
import assert from 'node:assert/strict';
import { renderStorefrontPage, renderCommerceCodeEmail, renderCommerceTransactionalEmail } from '../dist/index.js';

test('renderStorefrontPage generates accessible, brand-neutral page shell', () => {
  const brand = {
    brandId: 'artisan-creators',
    productName: 'Artisan',
    studioName: 'Artisan Studio',
    tagline: 'Direct creator marketplace',
    accentColor: '#105238',
  };

  const page = renderStorefrontPage(brand);
  assert.ok(page.html.includes('data-product-brand="artisan-creators"'));
  assert.ok(page.html.includes('<title>Purchases · Artisan</title>'));
  assert.ok(page.html.includes('Artisan Studio'));
  assert.ok(page.html.includes('Direct creator marketplace'));
  assert.ok(page.html.includes('href="#commerceContent">Skip to content</a>'));
  assert.ok(page.clientJavaScript.includes('artisan-creators') || page.clientJavaScript.includes('Artisan'));
  assert.ok(page.contentSecurityPolicy.includes("default-src 'self'"));
});

test('renderCommerceCodeEmail validates 6-digit code and formats plaintext and responsive HTML', () => {
  const brand = {
    brandId: 'indie-studio',
    productName: 'IndieCore',
    studioName: 'IndieCore Studio',
    accentColor: '#1f4e79',
  };

  assert.throws(() => renderCommerceCodeEmail('abc12', brand), /Invalid verification code/);
  assert.throws(() => renderCommerceCodeEmail('12345', brand), /Invalid verification code/);
  assert.throws(() => renderCommerceCodeEmail('1234567', brand), /Invalid verification code/);

  const { text, html } = renderCommerceCodeEmail('492817', brand);
  assert.ok(text.includes('Your IndieCore sign-in code is 492817'));
  assert.ok(text.includes('This code expires in 10 minutes'));
  assert.ok(html.includes('492817'));
  assert.ok(html.includes('#1f4e79'));
  assert.ok(html.includes('IndieCore'));
});

test('renderCommerceTransactionalEmail transforms verified URLs with call-to-action buttons', () => {
  const brand = {
    brandId: 'indie-studio',
    productName: 'IndieCore',
    studioName: 'IndieCore Studio',
  };

  const publicBaseUrl = 'https://store.example.test';
  const validMessage = {
    to: 'buyer@example.test',
    subject: 'Claim your purchase',
    text: 'https://store.example.test/commerce/claim?id=order-123&token=claim-secret-tok',
    idempotencyKey: 'idemp-1',
  };

  const rendered = renderCommerceTransactionalEmail(validMessage, brand, publicBaseUrl);
  assert.ok(rendered.html.includes('Claim your purchase'));
  assert.ok(rendered.html.includes('https://store.example.test/commerce/claim?id=order-123&amp;token=claim-secret-tok'));
  assert.ok(rendered.text.includes('Claim your purchase:'));

  // Invalid base origin is not transformed into HTML template
  const invalidUrlMessage = {
    to: 'buyer@example.test',
    subject: 'Claim your purchase',
    text: 'https://evil-attacker.example.test/commerce/claim?id=order-123&token=claim-secret-tok',
    idempotencyKey: 'idemp-2',
  };
  const unrendered = renderCommerceTransactionalEmail(invalidUrlMessage, brand, publicBaseUrl);
  assert.equal(unrendered.html, undefined);
});
