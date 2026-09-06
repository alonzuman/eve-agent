import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import https from "node:https";
import dns from "node:dns/promises";
import sharp from "sharp";
import { fetchOptionImage, isPublicAddress } from "../src/visual/fetch-image.js";
import { cardsSchema, cardSetId, cardSendKey } from "../src/visual/cards.js";
import { renderCard, cardTree } from "../src/visual/render-card.js";
import { deliverCards } from "../src/visual/deliver-cards.js";

export const sampleSet = cardsSchema.parse({
  introduction: "A few flower ideas.",
  cards: Array.from({ length: 3 }, (_, index) => ({
    html: '<div style="display:flex;width:100%;height:100%;background:#11221b;color:white;font-size:60px;padding:60px">{{TITLE}}</div>',
    props: { TITLE: `Bouquet ${index + 1} & greenery` },
    label: `Bouquet ${index + 1} — $65 USD + delivery`, sourceUrl: `https://example.com/product/${index}`,
  })),
});

test("card inputs bound batch size, canvas dimensions, markup and props", () => {
  for (const count of [0, 6]) assert.equal(cardsSchema.safeParse({ ...sampleSet, cards: Array(count).fill(sampleSet.cards[0]) }).success, false);
  assert.equal(cardsSchema.safeParse({ ...sampleSet, width: 10000 }).success, false);
  assert.equal(cardsSchema.safeParse({ ...sampleSet, introduction: "hello\nworld" }).success, false);
  for (const sourceUrl of ["http://example.com/x", "file:///etc/passwd", "https://user:secret@example.com/x", "https://example.com:8080/x"]) {
    assert.equal(cardsSchema.safeParse({ ...sampleSet, cards: sampleSet.cards.map(card => ({ ...card, sourceUrl })) }).success, false);
  }
});

test("placeholder props remain literal text, preserve URL query strings, and support inline CSS values", () => {
  const tree = cardTree({ html: '<div style="color:{{COLOR}};font-size:{{SIZE}}">{{TEXT}}<img src="{{PHOTO}}" width="1000" height="850" /></div>', props: {
    COLOR: '#123456', SIZE: '40px', TEXT: '<script>alert(1)</script> & \"quoted\"', PHOTO: 'https://example.com/a?x=1&y=2',
  } });
  const json = JSON.stringify(tree);
  assert.ok(json.includes('<script>alert(1)</script> &'));
  assert.ok(json.includes('https://example.com/a?x=1&y=2'));
  assert.ok(json.includes('"color":"#123456"'));
  assert.ok(json.includes('"width":1000'));
  assert.ok(json.includes('"height":850'));
  assert.ok(!json.includes('"type":"script"'));
  assert.throws(() => cardTree({ html: '<div>{{MISSING}}</div>', props: {} }), /Missing card prop/);
});

test("card markup cannot introduce executable content or renderer-side network fetches", () => {
  for (const html of [
    '<script>alert(1)</script>', '<style>div{color:red}</style>', '<iframe src="https://example.com"/>',
    '<img src="https://example.com/a" onerror="alert(1)" />', '<svg><image href="file:///etc/passwd"/></svg>',
    '<div style="background-image:url(https://127.0.0.1/x)">hi</div>',
    '<div style="background-image:{{BG}}">hi</div>',
  ]) assert.throws(() => cardTree({ html, props: { BG: 'url(https://127.0.0.1/x)' } }));
});

test("image downloads reject local, mapped, reserved, and metadata addresses", async () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  for (const url of ["https://127.1/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://169.254.169.254/latest/meta-data/"]) await assert.rejects(fetchOptionImage(url), /not public/);
});

test("image downloader pins checked DNS results, rechecks redirects, and bounds response types and bytes", async t => {
  let replies: { statusCode: number; headers: Record<string, string>; body?: Buffer }[] = [];
  const lookups: https.RequestOptions[] = [];
  t.mock.method(https, "get", (_url: URL, options: https.RequestOptions, callback: (response: unknown) => void) => {
    lookups.push(options);
    const request = new EventEmitter();
    queueMicrotask(() => {
      const reply = replies.shift()!;
      const response = Object.assign(new PassThrough(), reply);
      callback(response);
      if (!response.destroyed) response.end(reply.body);
    });
    return request;
  });
  replies = [{ statusCode: 200, headers: { "content-type": "image/png" }, body: Buffer.from("image") }];
  assert.equal((await fetchOptionImage("https://images.example.com/photo")).toString(), "image");
  t.mock.method(dns, "lookup", async () => [{ address: "10.0.0.1", family: 4 }]);
  await new Promise<void>(resolve => lookups[0].lookup!("images.example.com", {}, error => { assert.match(error!.message, /not public/); resolve(); }));
  t.mock.method(dns, "lookup", async () => [{ address: "8.8.8.8", family: 4 }]);
  await new Promise<void>(resolve => lookups[0].lookup!("images.example.com", {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); resolve(); }));
  replies = [{ statusCode: 302, headers: { location: "https://127.0.0.1/secret" } }];
  await assert.rejects(fetchOptionImage("https://images.example.com/photo"), /not public/);
  const rejectedHeaders: Record<string, string>[] = [{ "content-type": "image/svg+xml" }, { "content-type": "image/png", "content-length": "10485761" }];
  for (const headers of rejectedHeaders) {
    replies = [{ statusCode: 200, headers }];
    await assert.rejects(fetchOptionImage("https://images.example.com/photo"), /Unsupported or oversized/);
  }
  replies = [{ statusCode: 200, headers: { "content-type": "image/png" }, body: Buffer.alloc(10 * 1024 * 1024 + 1) }];
  await assert.rejects(fetchOptionImage("https://images.example.com/photo"), /exceeds/);
});

test("generic HTML renderer produces a phone-size PNG without filesystem font dependencies", async () => {
  const rendered = await renderCard(sampleSet.cards[0]);
  const metadata = await sharp(rendered).metadata();
  assert.equal(metadata.format, "png"); assert.equal(metadata.width, 1000); assert.equal(metadata.height, 1250);
  assert.ok(rendered.length < 1024 * 1024);
  await assert.rejects(renderCard({ html: '<img src="https://127.0.0.1/x" />', props: {} }), /not public/);
  await assert.rejects(renderCard(sampleSet.cards[0], { abortSignal: AbortSignal.abort() }));
});

test("one ordered multi-attachment send uses stable, session-isolated idempotency and sanitizes failures", async () => {
  const id = cardSetId(sampleSet, "present-1");
  const prepared = { id, set: sampleSet, images: ["YQ==", "Yg==", "Yw=="], receipt: null };
  let calls = 0;
  const receipt = await deliverCards(prepared, "session-a", async (message, options) => {
    calls++;
    assert.deepEqual(message.files.map(file => file.data.toString()), ["a", "b", "c"]);
    assert.deepEqual(message.files.map(file => file.filename), ["card-1.png", "card-2.png", "card-3.png"]);
    assert.ok(message.files.every(file => file.mimeType === "image/png"));
    assert.match(message.markdown, /2\. Bouquet 2/);
    assert.match(message.markdown, /https:\/\/example.com\/product\/1/);
    assert.equal(options.idempotencyKey, cardSendKey("session-a", id));
    return { id: "linq-message-1" };
  });
  assert.equal(calls, 1); assert.equal(receipt.status, "sent");
  assert.notEqual(cardSendKey("session-a", id), cardSendKey("session-b", id));
  assert.equal(cardSetId(JSON.parse(JSON.stringify(sampleSet)), "present-1"), id);
  assert.notEqual(cardSetId(sampleSet, "present-2"), id);
  const failed = await deliverCards(prepared, "session-a", async () => { throw new Error("secret-provider-token"); });
  assert.equal(failed.status, "failed"); assert.ok(!JSON.stringify(failed).includes("secret-provider-token"));
  assert.equal((await deliverCards(prepared, "session-a", async () => ({ id: "" }))).status, "failed");
});
