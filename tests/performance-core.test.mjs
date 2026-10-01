import assert from 'node:assert/strict';
import test from 'node:test';
import { SearchPageCache, albumTileSignature } from '../performance-core.js';
test('search cache keeps complete history pages in memory and expires', () => {
  let now = 0;
  const cache = new SearchPageCache({ now:() => now, ttlMs:100 });
  cache.set('d', [{key:'a',msg:{text:'past'}},{key:'b',msg:{text:'old'}}], 2);
  assert.equal(cache.get('d').length, 2);
  now = 100;
  assert.equal(cache.get('d'), null);
  assert.equal(cache.bytes, 0);
});
test('message edits, deletions, new heads and backdated inserts invalidate the covering page', () => {
  const cache = new SearchPageCache();
  cache.set(null, [{key:'m'},{key:'z'}], 2);
  cache.set('m', [{key:'c'},{key:'l'}], 2);
  cache.set('c', [{key:'a'}], 2);
  cache.invalidate('n');
  assert.equal(cache.get(null), null);
  assert.ok(cache.get('m'));
  cache.invalidate('f');
  assert.equal(cache.get('m'), null);
  cache.invalidate('0');
  assert.equal(cache.get('c'), null);
});
test('search cache is bounded and logout invalidates outstanding generations', () => {
  const cache = new SearchPageCache({maxBytes:100});
  cache.set('b', [{key:'a',msg:{text:'one'}}], 2);
  cache.set('d', [{key:'c',msg:{text:'two'}}], 2);
  cache.set('f', [{key:'e',msg:{text:'three'}}], 2);
  assert.ok(cache.bytes <= 100);
  const generation = cache.generation;
  cache.clear();
  assert.equal(cache.entries.size, 0);
  assert.ok(cache.generation > generation);
});
test('unchanged album tiles retain signatures, thumbnail/source changes replace them', () => {
  const item = {key:'k',type:'video',url:'x',ts:1};
  assert.equal(albumTileSignature(item), albumTileSignature({...item,key:'other'}));
  assert.notEqual(albumTileSignature(item), albumTileSignature({...item,thumbnail:'data:image/jpeg;base64,xx'}));
  assert.notEqual(albumTileSignature(item), albumTileSignature({...item,messageKey:'m'}));
});
