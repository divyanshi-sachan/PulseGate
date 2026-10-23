import { createHash } from 'node:crypto';

/**
 * Atomic token bucket (ADR-0005, ADR-0034). KEYS[1] = bucket; ARGV = capacity, refill per second.
 * Uses the Redis server clock, so gateway instances with skewed clocks share one consistent budget.
 * Tokens are stored and returned as strings: Lua numbers would be truncated to integers in replies.
 */
export const TOKEN_BUCKET_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end

local elapsed = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * rate)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
-- Expire once the bucket would be full again: an expired bucket equals a new one (lossless).
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity - tokens) / rate * 1000) + 1000)
return { allowed, tostring(tokens) }
`;

export const TOKEN_BUCKET_SHA1 = createHash('sha1').update(TOKEN_BUCKET_SCRIPT).digest('hex');
