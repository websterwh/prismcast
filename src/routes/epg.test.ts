/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * epg.test.ts: Unit tests for the XMLTV EPG endpoint in epg.ts.
 */
import type { AddressInfo, Server } from "node:net";
import { after, before, describe, test } from "node:test";
import { generateXmltvContent, setupEpgEndpoint } from "./epg.ts";
import assert from "node:assert/strict";
import express from "express";

function makeServer(): Promise<{ port: number; server: Server }> {

  const app = express();

  setupEpgEndpoint(app);

  return new Promise((resolve, reject) => {

    const server = app.listen(0, "127.0.0.1", () => {

      const address = server.address() as AddressInfo;

      resolve({ port: address.port, server });
    });

    server.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {

  return new Promise((resolve) => {

    server.close(() => {

      resolve();
    });
  });
}

describe("generateXmltvContent", () => {

  test("generates valid XMLTV document with channel and programme blocks", () => {

    const xml = generateXmltvContent();

    assert.ok(xml.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"), "XML starts with declaration");
    assert.ok(xml.includes("<tv generator-info-name=\"PrismCast\">"), "has tv root element");
    assert.ok(xml.includes("<channel id="), "contains channel elements");
    assert.ok(xml.includes("<display-name>"), "contains display-name elements");
    assert.ok(xml.includes("<programme start="), "contains programme elements");
    assert.ok(xml.endsWith("</tv>"), "ends with closing tv tag");
  });
});

describe("setupEpgEndpoint", () => {

  let port = 0;
  let server: Server;

  before(async () => {

    const s = await makeServer();

    port = s.port;
    server = s.server;
  });

  after(async () => {

    await closeServer(server);
  });

  test("GET /epg.xml returns XMLTV with correct content type", async () => {

    const res = await fetch("http://127.0.0.1:" + String(port) + "/epg.xml");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/xml/);

    const body = await res.text();

    assert.ok(body.includes("<tv generator-info-name=\"PrismCast\">"));
    assert.ok(body.includes("</tv>"));
  });

  test("GET /xmltv.xml returns the same XMLTV content", async () => {

    const res = await fetch("http://127.0.0.1:" + String(port) + "/xmltv.xml");

    assert.equal(res.status, 200);

    const body = await res.text();

    assert.ok(body.includes("<tv generator-info-name=\"PrismCast\">"));
  });
});
