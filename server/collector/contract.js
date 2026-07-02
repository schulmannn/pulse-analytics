'use strict';

const crypto = require('crypto');
const { captionSnippet } = require('../lib/caption');

const CURRENT_SCHEMA_VERSION = 1;
const SUPPORTED_SCHEMA_VERSIONS = [1];
const MAX_ROWS = 500;
const MAX_SNAPSHOT_BYTES = 2_000_000;
const MAX_SAFE_METRIC = 9_000_000_000_000_000;
const MAX_DB_INTEGER = 2_147_483_647;

class ContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ContractError';
    this.code = 'INVALID_COLLECTOR_PAYLOAD';
    this.details = details;
  }
}

const text = (value, max = 500) => value == null ? null : String(value).trim().slice(0, max);

function number(value, { integer = false, min = -MAX_SAFE_METRIC, max = MAX_SAFE_METRIC, nullable = true } = {}) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw new ContractError('required numeric value is missing');
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new ContractError(`numeric value is outside ${min}..${max}`);
  }
  return integer ? Math.round(result) : result;
}

function isoDate(value, fallback) {
  const date = value == null ? new Date(fallback || Date.now()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new ContractError('collected_at must be an ISO date');
  return date.toISOString();
}

function sanitizeJson(value, depth = 0) {
  if (depth > 8) throw new ContractError('payload nesting is too deep');
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > MAX_SAFE_METRIC) {
      throw new ContractError('payload contains a non-finite or oversized number');
    }
    return value;
  }
  if (typeof value === 'string') return value.slice(0, 4000);
  if (Array.isArray(value)) {
    if (value.length > MAX_ROWS) throw new ContractError(`array exceeds ${MAX_ROWS} items`);
    return value.map(item => sanitizeJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 120) throw new ContractError('object has too many fields');
    const out = {};
    for (const [key, item] of entries) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
        throw new ContractError(`forbidden object key: ${key}`);
      }
      out[String(key).slice(0, 100)] = sanitizeJson(item, depth + 1);
    }
    return out;
  }
  throw new ContractError(`unsupported JSON value type: ${typeof value}`);
}

function normalizeNumericTree(value, key = '') {
  if (Array.isArray(value)) {
    if (/^(x|values|hours)$/.test(key)) {
      const max = key === 'x' || key === 'hours' ? MAX_SAFE_METRIC : MAX_DB_INTEGER;
      return value.map(v => v == null && key !== 'x'
        ? null
        : number(v, { min: 0, max, nullable: false }));
    }
    return value.map(v => normalizeNumericTree(v));
  }
  if (!value || typeof value !== 'object') {
    if (key === 'id') return number(value, { integer: true, min: 1, max: MAX_SAFE_METRIC });
    if (/^(members|admins|online|current|previous|value|views|forwards|reactions|replies|count|total|channels|avg_views|avg_forwards|posts_analyzed|posts_used|unique_channels|total_views|day|share|cum|day1_share|t80_days)$/.test(key)) {
      return number(value, { min: 0, max: MAX_DB_INTEGER });
    }
    return value;
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = normalizeNumericTree(childValue, childKey);
  }
  return out;
}

function normalizePost(post) {
  if (!post || typeof post !== 'object') throw new ContractError('posts must contain objects');
  const id = number(post.id, { integer: true, min: 1, nullable: false });
  return {
    id,
    date: post.date ? isoDate(post.date) : null,
    text: text(post.text, 1000) || '',
    views: number(post.views, { integer: true, min: 0, max: MAX_DB_INTEGER }) || 0,
    forwards: number(post.forwards, { integer: true, min: 0, max: MAX_DB_INTEGER }) || 0,
    replies: number(post.replies, { integer: true, min: 0, max: MAX_DB_INTEGER }) || 0,
    reactions: number(post.reactions, { integer: true, min: 0, max: MAX_DB_INTEGER }) || 0,
    reactions_detail: sanitizeJson(post.reactions_detail || []),
    media_type: text(post.media_type, 40) || 'text',
    hashtags: Array.isArray(post.hashtags)
      ? post.hashtags.slice(0, 20).map(tag => text(tag, 80)).filter(Boolean)
      : [],
    album_size: number(post.album_size, { integer: true, min: 0, max: 100 }) || 0,
    pinned: !!post.pinned,
  };
}

function normalizeMention(mention) {
  if (!mention || typeof mention !== 'object') throw new ContractError('mentions must contain objects');
  return {
    channel_id: number(mention.channel_id, { integer: true, min: 1, nullable: false }),
    msg_id: number(mention.msg_id, { integer: true, min: 1, nullable: false }),
    date: mention.date ? isoDate(mention.date) : null,
    title: text(mention.title, 300),
    username: text(mention.username, 100),
    link: text(mention.link, 500),
    snippet: text(mention.snippet, 1000),
    views: number(mention.views, { integer: true, min: 0, max: MAX_DB_INTEGER }) || 0,
    query: text(mention.query, 200),
  };
}

function normalizeEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContractError('collector payload must be a JSON object');
  }
  const rawVersion = input.schema_version == null ? CURRENT_SCHEMA_VERSION : Number(input.schema_version);
  if (!Number.isInteger(rawVersion) || !SUPPORTED_SCHEMA_VERSIONS.includes(rawVersion)) {
    throw new ContractError(`unsupported schema_version: ${input.schema_version}`, [{
      supported: SUPPORTED_SCHEMA_VERSIONS,
    }]);
  }
  const legacy = input.ingest_id == null;
  if (!legacy && (input.collected_at == null || input.collector_version == null || input.schema_version == null)) {
    throw new ContractError('versioned payload requires schema_version, collector_version and collected_at');
  }
  const sourceForLegacyId = JSON.stringify(input);
  const ingestId = legacy
    ? `legacy-${crypto.createHash('sha256').update(sourceForLegacyId).digest('hex').slice(0, 32)}`
    : text(input.ingest_id, 100);
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(ingestId || '')) {
    throw new ContractError('ingest_id must be 8-100 safe characters');
  }

  const channel = input.channel == null ? null : normalizeNumericTree(sanitizeJson(input.channel));
  if (channel && channel.username != null) channel.username = text(channel.username, 100);
  if (channel && channel.title != null) channel.title = text(channel.title, 300);
  const posts = (Array.isArray(input.posts) ? input.posts : []).slice(0, MAX_ROWS).map(normalizePost);
  const mentions = (Array.isArray(input.mentions) ? input.mentions : []).slice(0, MAX_ROWS).map(normalizeMention);

  const normalized = {
    schema_version: rawVersion,
    ingest_id: ingestId,
    collector_version: text(input.collector_version, 80) || (legacy ? 'legacy' : 'unknown'),
    collected_at: input.collected_at == null
      ? isoDate(legacy ? 0 : Date.now())
      : isoDate(input.collected_at),
    channel,
    stats: input.stats == null ? null : normalizeNumericTree(sanitizeJson(input.stats)),
    graphs: input.graphs == null ? null : normalizeNumericTree(sanitizeJson(input.graphs)),
    views_summary: input.views_summary == null ? null : normalizeNumericTree(sanitizeJson(input.views_summary)),
    posts,
    velocity: input.velocity == null ? null : normalizeNumericTree(sanitizeJson(input.velocity)),
    mentions,
    legacy,
  };
  const snapshot = {
    channel: normalized.channel,
    stats: normalized.stats,
    graphs: normalized.graphs,
    views_summary: normalized.views_summary,
    posts: normalized.posts.slice(0, 200),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw new ContractError('snapshot exceeds 2 MB');
  }
  return normalized;
}

function prepareStorage(normalized, graphsToDailyRows) {
  const postRows = normalized.posts.map(post => {
    const reach = post.views || 0;
    const engagement = post.reactions + post.forwards + post.replies;
    return {
      post_id: post.id,
      date_published: post.date,
      views: post.views,
      reactions: post.reactions,
      forwards: post.forwards,
      replies: post.replies,
      erv: reach > 0 ? engagement / reach * 100 : null,
      virality: reach > 0 ? post.forwards / reach * 100 : null,
      media_type: post.media_type,
      caption: captionSnippet(post.text),
      hashtags: post.hashtags,
    };
  });
  return {
    snapshot: {
      channel: normalized.channel,
      stats: normalized.stats,
      graphs: normalized.graphs,
      views_summary: normalized.views_summary,
      posts: normalized.posts.slice(0, 200),
    },
    dailyRows: graphsToDailyRows(normalized.graphs).slice(0, MAX_ROWS),
    postRows,
    velocity: normalized.velocity,
    mentions: normalized.mentions,
    tgChannelId: normalized.channel && normalized.channel.id,
  };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  ContractError,
  normalizeEnvelope,
  prepareStorage,
};
