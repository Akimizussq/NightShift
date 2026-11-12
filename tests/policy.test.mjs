import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, schedule, normalizeQuota, validateSettings } from '../build/shared/policy.js';
import { DEFAULT_SETTINGS as s } from '../build/shared/types.js';
const when = (hour, minute=0) => new Date(2026,10,12,hour,minute).getTime();
const quota = (now, shortUsed=10, weeklyUsed=20, reset=when(11)) => ({ source:'live', fetchedAt:now,
  short:{ usedPercent:shortUsed,windowDurationMins:300,resetsAt:reset },
  weekly:{ usedPercent:weeklyUsed,windowDurationMins:10080,resetsAt:when(12)+86400000*3 } });

test('10:00 wake + one hour refresh anchors at 06:00, including the previous evening', () => {
  assert.equal(schedule(when(2),s).anchorAt,when(6));
  assert.equal(schedule(when(2),s).desiredReset,when(11));
  assert.equal(schedule(when(2),s).startAt,when(0)-3600000);
  assert.equal(schedule(when(22),s).startAt,when(23));
});
test('morning protection includes the 7-point buffer and acts at the exact boundary', () => {
  assert.equal(decide(when(8),s,quota(when(8),42)).action,'run');
  assert.equal(decide(when(8),s,quota(when(8),43)).action,'protect');
  assert.equal(decide(when(8),s,quota(when(8),80)).action,'protect');
});
test('a window extending into the morning is protected before 06:00', () => {
  assert.equal(decide(when(4),s,quota(when(4),43,20,when(9))).action,'protect');
});
test('weekly floor overrides all continuation, with buffer before the 30% target', () => {
  assert.equal(decide(when(8),s,quota(when(8),5,63)).action,'stop');
  assert.equal(decide(when(8),s,quota(when(8),5,62)).action,'run');
});
test('missing and stale telemetry fail closed; unknown buckets are not guessed', () => {
  assert.equal(decide(when(8),s,null).action,'block');
  const q = quota(when(8)); q.weekly=null;
  assert.equal(decide(when(8),s,q).action,'block');
  assert.equal(decide(when(8),s,quota(when(8)-181000)).action,'block');
  assert.equal(normalizeQuota({rateLimitsByLimitId:{other:{primary:{usedPercent:0,windowDurationMins:300,resetsAt:1}}}}).short,null);
});
test('normalizes actual duration and seconds, independent of primary/secondary order', () => {
  const q = normalizeQuota({rateLimits:{primary:{usedPercent:20,windowDurationMins:10080,resetsAt:1234},secondary:{usedPercent:45,windowDurationMins:300,resetsAt:2345}}},100);
  assert.equal(q.short.usedPercent,45); assert.equal(q.short.resetsAt,2345000); assert.equal(q.weekly.usedPercent,20);
});
test('fresh expired-window metadata permits a recovery attempt at anchor, not at 04:00', () => {
  const q = quota(when(4,1),100,20,when(4));
  assert.equal(decide(when(4,1),s,q).action,'wait');
  assert.equal(decide(when(4,1),s,q).nextAt,when(6));
  q.fetchedAt=when(6);
  assert.equal(decide(when(6),s,q).action,'run');
});
test('old pre-reset snapshot cannot authorize a new model request', () => {
  assert.equal(decide(when(6),s,quota(when(5,59),100,20,when(6))).action,'wait');
});
test('daytime waits for the next night; no implicit restart on quota reset', () => {
  assert.equal(decide(when(12),s,quota(when(12),10,20,when(15))).action,'wait');
  assert.equal(decide(when(12),s,quota(when(12),10,20,when(15))).nextAt,when(23));
});
test('invalid policy values and malformed times are rejected', () => {
  assert.throws(()=>validateSettings({...s,morningReserve:99}));
  assert.throws(()=>validateSettings({...s,wakeTime:'25:00'}));
  assert.throws(()=>validateSettings({...s,pollSeconds:0}));
  assert.deepEqual(validateSettings(s),s);
});
