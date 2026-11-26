import assert from "node:assert/strict";
import { test } from "node:test";

import { blockedKind, canonicalIp } from "../lib/address.ts";
import { entryDirectory } from "../lib/cache.ts";
import { cleanText } from "../lib/text.ts";
import { canonicalUrl, validateUrl } from "../lib/url.ts";

test("3.1 refuses an invalid URL, another scheme, and credentials, in that order", () => {
  assert.throws(() => validateUrl("not a url"), {
    message: "WebFetch: not a valid URL: not a url",
  });
  assert.throws(() => validateUrl("ftp://u:p@example.com/"), {
    message: "WebFetch: only http and https URLs are fetched, not ftp:",
  });
  assert.throws(() => validateUrl("https://u:p@example.com/"), {
    message: "WebFetch: URLs with credentials are refused",
  });
});

test("3.2 the canonical URL drops the fragment and tracking parameters, sorts the rest, lowercases the host", () => {
  const url = validateUrl(
    "HTTPS://Example.COM:443/Path?b=2&UTM_source=x&a=2&fbclid=1&a=1&gclid=z#frag",
  );
  assert.equal(canonicalUrl(url), "https://example.com/Path?a=1&a=2&b=2");
  assert.equal(
    canonicalUrl(validateUrl("http://example.com/x?utm_medium=y#top")),
    "http://example.com/x",
  );
});

test("4.2 an entry lives at <host>/<slug>-<hash>", () => {
  assert.match(
    entryDirectory("https://example.com/Docs/Intro_Page.html"),
    /^example\.com\/docs-intro-page-html-[0-9a-f]{8}$/,
  );
  assert.match(
    entryDirectory("http://example.com:8080/"),
    /^example\.com_8080\/index-[0-9a-f]{8}$/,
  );
  assert.match(entryDirectory("http://[::1]:81/a"), /^__1_81\/a-[0-9a-f]{8}$/);
  const long = entryDirectory(`https://example.com/${"a".repeat(59)}/bbb`);
  assert.match(long, /^example\.com\/a{59}-[0-9a-f]{8}$/);
});

test("3.4 classifies every blocked range, embedded IPv4 included, and passes public addresses", () => {
  const cases: [string, string | undefined][] = [
    ["0.1.2.3", "unspecified"],
    ["::", "unspecified"],
    ["127.0.0.2", "loopback"],
    ["::1", "loopback"],
    ["10.1.1.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["100.64.0.1", "shared"],
    ["169.254.169.254", "link-local"],
    ["fe80::1", "link-local"],
    ["fd12:3456::1", "unique-local"],
    ["224.0.0.1", "multicast"],
    ["ff02::1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:7f00:1", "loopback"],
    ["64:ff9b::a9fe:a9fe", "link-local"],
    ["93.184.215.14", undefined],
    ["172.32.0.1", undefined],
    ["2606:2800:220:1::1", undefined],
    ["::ffff:8.8.8.8", undefined],
  ];
  for (const [ip, kind] of cases) assert.equal(blockedKind(ip), kind, ip);
});

test("2.2 allowed addresses compare in canonical form", () => {
  assert.equal(canonicalIp("0:0:0:0:0:0:0:1"), "::1");
  assert.equal(canonicalIp("127.0.0.1"), "127.0.0.1");
});

test("6.4 text cleaning keeps tab and line feed and maps other white space to one space", () => {
  assert.equal(cleanText("a\tb\nc\r\n\u00A0\u2028d  e"), "a\tb\nc\n d  e");
});
