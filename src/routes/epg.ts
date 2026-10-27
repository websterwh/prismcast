/* Copyright(C) 2024-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * epg.ts: XMLTV electronic program guide route for Plex and other streaming clients.
 */
import type { Express, Request, Response } from "express";
import { buildChannelMap } from "../hdhr/channelMap.ts";
import { getAllChannels } from "../config/userChannels.ts";
import { systemClock } from "homebridge-plugin-utils";

/**
 * Escapes special XML characters to prevent malformed XMLTV output.
 * @param value - The raw string value.
 * @returns The XML-escaped string.
 */
function escapeXml(value: string): string {

  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Formats a Date into an XMLTV date string: YYYYMMDDHHMMSS +0000.
 * @param d - The Date object.
 * @returns The XMLTV-formatted date string.
 */
function formatXmltvDate(d: Date): string {

  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());
  const seconds = pad(d.getUTCSeconds());

  return String(year) + month + day + hours + minutes + seconds + " +0000";
}

/**
 * Generates XMLTV guide content from the configured channel lineup and HDHomeRun mapping.
 * Each channel in the HDHR channel map is included with its numeric GuideNumber as its channel ID,
 * display names, logo (if defined), and rolling 2-hour program blocks from 6 hours ago to 48 hours ahead.
 * @returns Complete XMLTV XML string.
 */
export function generateXmltvContent(): string {

  const channelMap = buildChannelMap();
  const allChannels = getAllChannels();
  const lines: string[] = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE tv SYSTEM \"xmltv.dtd\">",
    "<tv generator-info-name=\"PrismCast\">"
  ];

  for(const entry of channelMap) {

    const channel = allChannels[entry.key];
    const channelId = String(entry.number);

    lines.push("  <channel id=\"" + channelId + "\">");
    lines.push("    <display-name>" + escapeXml(entry.name) + "</display-name>");
    lines.push("    <display-name>" + channelId + "</display-name>");
    lines.push("    <display-name>" + channelId + " " + escapeXml(entry.name) + "</display-name>");

    if(channel?.logoUrl) {

      lines.push("    <icon src=\"" + escapeXml(channel.logoUrl) + "\" />");
    }

    lines.push("  </channel>");
  }

  // Generate 2-hour rolling program blocks from 6 hours ago to 48 hours ahead.
  const now = new Date(systemClock.now());
  const startHour = Math.floor(now.getUTCHours() / 2) * 2;
  const baseTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), startHour - 6, 0, 0));
  const totalBlocks = 27;

  for(let i = 0; i < totalBlocks; i++) {

    const blockStart = new Date(baseTime.getTime() + (i * 2 * 60 * 60 * 1000));
    const blockEnd = new Date(blockStart.getTime() + (2 * 60 * 60 * 1000));
    const startStr = formatXmltvDate(blockStart);
    const stopStr = formatXmltvDate(blockEnd);

    for(const entry of channelMap) {

      const channelId = String(entry.number);
      const name = escapeXml(entry.name);

      lines.push("  <programme start=\"" + startStr + "\" stop=\"" + stopStr + "\" channel=\"" + channelId + "\">");
      lines.push("    <title lang=\"en\">" + name + "</title>");
      lines.push("    <desc lang=\"en\">" + name + " Live Broadcast</desc>");
      lines.push("  </programme>");
    }
  }

  lines.push("</tv>");

  return lines.join("\n");
}

/**
 * Registers the XMLTV EPG endpoints on the Express application.
 * @param app - The Express application.
 */
export function setupEpgEndpoint(app: Express): void {

  const handler = (_req: Request, res: Response): void => {

    const xml = generateXmltvContent();

    res.set("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  };

  app.get("/epg.xml", handler);
  app.get("/xmltv.xml", handler);
  app.get("/epg", handler);
  app.get("/xmltv", handler);
}
