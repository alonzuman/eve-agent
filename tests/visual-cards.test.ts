import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import https from "node:https";
import dns from "node:dns/promises";
import sharp from "sharp";
import { asSchema } from "ai";
import { fetchOptionImage, isPublicAddress } from "../src/visual/fetch-image.js";
import { cardsSchema, cardSetId, cardSendKey, presentCardsInputSchema } from "../src/visual/cards.js";
import { renderCard, cardTree, readableCardTree, frameCard, CardTemplateError } from "../src/visual/render-card.js";
import { renderCardSet } from "../src/visual/render-card-set.js";
import { deliverCards } from "../src/visual/deliver-cards.js";

export const sampleSet = cardsSchema.parse({
  introduction: "A few flower ideas.",
  cards: Array.from({ length: 3 }, (_, index) => ({
    html: '<div style="display:flex;width:100%;height:100%;background:#11221b;color:white;font-size:60px;padding:60px">{{TITLE}}</div>',
    props: { TITLE: `Bouquet ${index + 1} & greenery` },
    label: `Bouquet ${index + 1} — $65 USD + delivery`, sourceUrl: `https://example.com/product/${index}`,
  })),
});

test("card tool exposes an object schema to model providers and validates action payloads", async () => {
  const schema = await asSchema(presentCardsInputSchema).jsonSchema;
  assert.equal(schema.type, "object");
  assert.equal(schema.anyOf, undefined);
  assert.equal(schema.oneOf, undefined);
  for (const action of ["status", "retry"]) assert.equal(presentCardsInputSchema.safeParse({ action }).success, true);
  assert.equal(presentCardsInputSchema.safeParse({ action: "present" }).success, false);
  assert.equal(presentCardsInputSchema.safeParse({ action: "present", ...sampleSet }).success, true);
  assert.equal(presentCardsInputSchema.safeParse({ action: "present", ...sampleSet, cards: [] }).success, false);
  assert.equal(presentCardsInputSchema.safeParse({ action: "send" }).success, false);
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

test("inline typography raises tiny text and resolves inherited and relative font sizes at any canvas width", () => {
  for (const width of [320, 1000, 1600]) {
    const tree = readableCardTree(cardTree({ html: '<div><span style="font-size:12px">Tiny</span><div style="font-size:100px"><span style="font-size:50%">Relative</span><span>Inherited</span></div><span style="font-size:0.1rem">Small</span></div>', props: {} }), width);
    const sizes: number[] = [];
    function visit(value: unknown) {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as { props: { style: { fontSize: number }; children?: unknown } };
      sizes.push(node.props.style.fontSize);
      visit(node.props.children);
    }
    visit(tree);
    assert.ok(sizes.every(size => size >= width * 0.056));
    assert.ok(sizes.includes(width * 0.064), "omitted root font uses readable default");
    assert.ok(sizes.includes(100), "larger authored font is retained");
    assert.ok(sizes.includes(Math.max(50, width * 0.056)), "percentage resolves against parent");
  }
});

test("every rendered card has a protected, visible top-right x/y header, including a single card", async () => {
  const blank = { html: '<div style="width:100%;height:100%;background:#ff0000;position:absolute;top:-100px">Body</div>', props: {} };
  const tree = cardTree(blank);
  const header = JSON.stringify(frameCard(tree, 1000, 1250, { index: 2, total: 4 }));
  assert.match(header, /2\/4/);
  assert.match(header, /"justifyContent":"flex-end"/);
  assert.match(header, /"overflow":"hidden"/);
  assert.throws(() => frameCard(tree, 1000, 1250, { index: 0, total: 4 }), /Invalid card position/);
  for (const count of [1, 2, 3, 4, 5]) {
    const image = await renderCard(blank, { position: { index: count, total: count } });
    const raw = await sharp(image).extract({ left: 800, top: 24, width: 150, height: 84 }).removeAlpha().raw().toBuffer();
    let white = 0, dark = 0;
    for (let index = 0; index < raw.length; index += 3) {
      if (raw[index] > 245 && raw[index + 1] > 245 && raw[index + 2] > 245) white++;
      if (raw[index] < 50 && raw[index + 1] < 50 && raw[index + 2] < 50) dark++;
    }
    assert.ok(white > 100 && dark > 1000, `visible high-contrast badge for ${count}/${count}`);
  }
});

test("card renders overlap and preserve numbering and input order despite reverse completion", async () => {
  const releases: (() => void)[] = [];
  const positions: unknown[] = [];
  const pending = renderCardSet(sampleSet, { render: async (card, options) => {
    positions.push(options?.position);
    await new Promise<void>(resolve => { releases.push(resolve); });
    return Buffer.from(card.props.TITLE);
  } });
  assert.equal(releases.length, 3, "all renders start before any finishes");
  for (const release of releases.reverse()) release();
  assert.deepEqual((await pending).map(image => Buffer.from(image, "base64").toString()), sampleSet.cards.map(card => card.props.TITLE));
  assert.deepEqual(positions, [{ index: 1, total: 3 }, { index: 2, total: 3 }, { index: 3, total: 3 }]);
});

test("failed batches abort and drain sibling renders, and bound aggregate bytes", async () => {
  let cancelled = 0;
  await assert.rejects(renderCardSet(sampleSet, { render: async (_card, options) => {
    if (options?.position?.index === 2) throw new CardTemplateError("Broken layout.");
    await new Promise<void>(resolve => options!.abortSignal!.addEventListener("abort", () => { cancelled++; resolve(); }, { once: true }));
    return Buffer.from("unused");
  } }), /card 2.*Broken layout/);
  assert.equal(cancelled, 2);
  await assert.rejects(renderCardSet(sampleSet, { render: async () => Buffer.alloc(4 * 1024 * 1024) }), /batch exceeds 10 MB/);
  let started = false;
  await assert.rejects(renderCardSet(sampleSet, { abortSignal: AbortSignal.abort(), render: async () => { started = true; return Buffer.alloc(1); } }));
  assert.equal(started, false);
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
