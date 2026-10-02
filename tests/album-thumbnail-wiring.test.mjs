import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const h=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
function between(start,end){return h.slice(h.indexOf(start),h.indexOf(end,h.indexOf(start)));}
test('album subscribes only to lean index and not full media',()=>{const room=between('function enterRoom()','async function initStickerPanel()');assert.match(room,/onValue\(ref\(db, `\$\{ROOM_ID\}\/albumIndex`\)/);assert.doesNotMatch(room,/onValue\(ref\(db, `\$\{ROOM_ID\}\/media`\)/);});
test('album cards use thumbnail-only factory for photos and videos',()=>{const cards=between('function createAlbumItem(item)','window.toggleAlbumFavoriteFilter');assert.match(cards,/createAlbumThumbnail\(item/);const beforeClick=cards.slice(0,cards.indexOf('div.onclick'));assert.doesNotMatch(beforeClick,/createVideoPreview|\.src\s*=\s*item.url|createElement\("video"\)/);assert.match(cards,/window.openLightbox\(item.type, item.url/);});
test('new media uploads generate thumbnails for photos and videos',()=>{const upload=between('async function uploadOneFile(file','function uploadFailureMessage');assert.match(upload,/isVideo \? generateVideoThumbnail\(targetFile\) : generateImageThumbnail\(targetFile\)/);assert.match(upload,/\/thumbs\/\$\{safeName\}\.jpg/);assert.match(upload,/thumbnailDataUrlToBlob/);assert.match(upload,/\.\.\.previewMetadata/);assert.doesNotMatch(upload,/\.\.\.preview\s/);});
test('new thumbnail fields propagate through media and proof creates',()=>{const single=between('async function sendSingleMedia','async function sendMediaGroup');assert.equal((single.match(/thumbnailStoragePath:uploaded.thumbnailStoragePath/g)||[]).length,2);const proof=between('window.uploadTodoProof','const JITSI_DOMAIN');assert.match(proof,/thumbnailStoragePath:uploaded.thumbnailStoragePath/);});
test('derived index is member-read-only and thumbs immutable bounded JPEG',()=>{const r=JSON.parse(fs.readFileSync(new URL('../database.rules.json',import.meta.url),'utf8'));assert.equal(r.rules.memo_private_room.albumIndex['.write'],false);assert.equal(r.rules.memo_private_room.albumIndex['.read'],r.rules.memo_private_room.media['.read']);const s=fs.readFileSync(new URL('../storage.rules',import.meta.url),'utf8');assert.match(s,/match \/memo_private_room\/thumbs\/\{fileName\}/);assert.match(s,/request.resource.size <= 16 \* 1024/);assert.match(s,/request.resource.contentType == 'image\/jpeg'/);});

function snapshotCallback(signature, page, context) {
  const base=signature==='snapshot.forEach('?h.indexOf('window.doSearch = async'):0;
  const start=h.indexOf(signature,base)+signature.length;
  assert.ok(start>=signature.length, 'snapshot callback exists');
  let depth=1,end=start;
  for(;end<h.length;end++) {
    if(h[end]==='(') depth++;
    if(h[end]===')' && --depth===0) break;
  }
  return new Function('page','context',`return (${h.slice(start,end)})`)(page,context);
}
function visitLikeRealtimeDatabase(callback) {
  for(let i=0;i<20;i++) {
    if(callback({key:`key-${i}`,val:()=>({text:`message-${i}`})})) break;
  }
}
test('native RTDB search enumeration does not cancel on Array.push return',()=>{
  const page=[];
  visitLikeRealtimeDatabase(snapshotCallback('snapshot.forEach(',page));
  assert.equal(page.length,20);
});
test('native RTDB before/after context enumeration does not cancel on Map.set return',()=>{
  for(const signature of ['beforeSnap.forEach(','afterSnap.forEach(']) {
    const context=new Map();
    visitLikeRealtimeDatabase(snapshotCallback(signature,null,context));
    assert.equal(context.size,20);
  }
});
