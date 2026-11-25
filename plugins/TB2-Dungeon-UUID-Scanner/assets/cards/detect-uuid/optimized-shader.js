/* Experimental HKDF extract-midstate kernel. Legacy WGSL remains in the controller unchanged. */
(() => {
    'use strict';
    const INITIAL = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const ROUND_CONSTANTS = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
  0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
  0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
  0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
  0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
  0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
  0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
  0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
  0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
    const rotate = (word, shift) => (word >>> shift) | (word << (32 - shift));

    /** Raw SHA-256 compression of one block, without padding or finalization. */
    function compressBlock(words) {
        const schedule = new Uint32Array(64);
        schedule.set(words);
        for (let index = 16; index < 64; index++) {
            const first = schedule[index - 15], second = schedule[index - 2];
            const sigma0 = rotate(first, 7) ^ rotate(first, 18) ^ (first >>> 3);
            const sigma1 = rotate(second, 17) ^ rotate(second, 19) ^ (second >>> 10);
            schedule[index] = schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1;
        }
        // Unsigned reductions are necessary: JS additions do not wrap like WGSL u32.
        let [a,b,c,d,e,f,g,h] = INITIAL;
        for (let index = 0; index < 64; index++) {
            const upper = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const choice = (e & f) ^ (~e & g);
            const first = (h + upper + choice + ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
            const lower = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            h=g; g=f; f=e; e=(d+first)>>>0; d=c; c=b; b=a; a=(first+lower+majority)>>>0;
        }
        return [a,b,c,d,e,f,g,h].map((word, index) => (word + INITIAL[index]) >>> 0);
    }

    /** Prepare the two constant HMAC salt blocks once per shader configuration. */
    function prepareExtractStates(saltBytes) {
        if (saltBytes.length !== 16) throw new Error('HKDF salt must contain exactly 16 bytes.');
        const inner = new Uint32Array(16).fill(0x36363636);
        const outer = new Uint32Array(16).fill(0x5c5c5c5c);
        const view = new DataView(saltBytes.buffer, saltBytes.byteOffset, saltBytes.byteLength);
        for (let index = 0; index < 4; index++) {
            const word = view.getUint32(index * 4, false);
            inner[index] ^= word;
            outer[index] ^= word;
        }
        return { inner: compressBlock(inner), outer: compressBlock(outer) };
    }

    /** Emit Midstate64, or the internal Ring16 benchmark variant; neither restricts the search. */
    function buildOptimizedShader(config) {
        const { cbcPairWords, padding, salt, info, xMask, unknownCount, schedule = "schedule64" } = config;
        const states = prepareExtractStates(salt);

        /**
         * Format numeric words as the original WGSL uint32 array literal.
         * @param {number[]} arr
         * @returns {string}
         */
        const wgslU32Array = (arr) => `array<u32,${arr.length}>(${arr.map(v => `0x${v.toString(
            16).padStart(8, '0')}u`).join(',')})`;
        if (cbcPairWords.length !== 8) {
            throw new Error(`Expected 8 u32 words for CBC pair, got ${cbcPairWords.length}.`);
        }
        const MAX_HITS = 256;
        return `
struct Params { batchStart : u32, batchCount : u32, fixedWord0 : u32, fixedWord1 : u32, };
const UUID_XMASK  : u32 = 0x${(xMask >>> 0).toString(16).padStart(8, '0')}u;
const UUID_UNK_CNT: u32 = ${unknownCount >>> 0}u;
@group(0) @binding(0) var<uniform>            params : Params;
@group(0) @binding(1) var<storage,read_write> hits   : array<atomic<u32>>;
const K = array<u32,64>(
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,
  0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,
  0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,
  0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,
  0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,
  0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,
  0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,
  0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,
  0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
);
fn rotr32(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn ch(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (~x & z); }
fn maj(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (x & z) ^ (y & z); }
fn Sigma0(x: u32) -> u32 { return rotr32(x,2u) ^ rotr32(x,13u) ^ rotr32(x,22u); }
fn Sigma1(x: u32) -> u32 { return rotr32(x,6u) ^ rotr32(x,11u) ^ rotr32(x,25u); }
fn sigma0(x: u32) -> u32 { return rotr32(x,7u) ^ rotr32(x,18u) ^ (x >> 3u); }
fn sigma1(x: u32) -> u32 { return rotr32(x,17u) ^ rotr32(x,19u) ^ (x >> 10u); }
fn sha256_block(state: ptr<function,array<u32,8>>, w_in: array<u32,16>) {
  ${schedule === 'ring16' ? 'var w = w_in;' : `var w: array<u32,64>;
  for (var i=0u; i<16u; i++) { w[i]=w_in[i]; }
  for (var i=16u; i<64u; i++) { w[i]=sigma1(w[i-2u])+w[i-7u]+sigma0(w[i-15u])+w[i-16u]; }`}
  var a=(*state)[0]; var b=(*state)[1]; var c=(*state)[2]; var d=(*state)[3];
  var e=(*state)[4]; var f=(*state)[5]; var g=(*state)[6]; var h=(*state)[7];
  for (var i=0u; i<64u; i++) {
    ${schedule === 'ring16' ? `if(i>=16u){
      let next = sigma1(w[(i-2u)&15u])+w[(i-7u)&15u]+sigma0(w[(i-15u)&15u])+w[i&15u];
      w[i&15u]=next;
    }` : ''}
    let T1=h+Sigma1(e)+ch(e,f,g)+K[i]+w[${schedule === 'ring16' ? 'i&15u' : 'i'}]; let T2=Sigma0(a)+maj(a,b,c);
    h=g; g=f; f=e; e=d+T1; d=c; c=b; b=a; a=T1+T2;
  }
  (*state)[0]+=a; (*state)[1]+=b; (*state)[2]+=c; (*state)[3]+=d;
  (*state)[4]+=e; (*state)[5]+=f; (*state)[6]+=g; (*state)[7]+=h;
}
fn sha256_init(state: ptr<function,array<u32,8>>) {
  (*state)[0]=0x6a09e667u; (*state)[1]=0xbb67ae85u;
  (*state)[2]=0x3c6ef372u; (*state)[3]=0xa54ff53au;
  (*state)[4]=0x510e527fu; (*state)[5]=0x9b05688cu;
  (*state)[6]=0x1f83d9abu; (*state)[7]=0x5be0cd19u;
}
fn sha256_finalize_1block(state: ptr<function,array<u32,8>>, w_partial: array<u32,16>, msgLen: u32) {
  var w=w_partial;
  let blockOff=msgLen&63u; let byteOff=blockOff&3u; let wordOff=blockOff>>2u;
  w[wordOff]=w[wordOff]|(0x80u<<(24u-byteOff*8u));
  for (var i=wordOff+1u; i<14u; i++) { w[i]=0u; }
  w[14]=0u; w[15]=msgLen*8u;
  sha256_block(state,w);
}
fn sha256_64plus32(first_block: array<u32,16>, inner: array<u32,8>) -> array<u32,8> {
  var state: array<u32,8>; sha256_init(&state); sha256_block(&state,first_block);
  var w: array<u32,16>;
  for (var i=0u; i<8u; i++) { w[i]=inner[i]; }
  sha256_finalize_1block(&state,w,96u); return state;
}
fn hmac_sha256_key32_msg20(key: array<u32,8>, msg20: array<u32,5>) -> array<u32,8> {
  var ipad: array<u32,16>; var opad: array<u32,16>;
  for (var i=0u; i<16u; i++) { ipad[i]=0x36363636u; opad[i]=0x5c5c5c5cu; }
  for (var i=0u; i<8u; i++) { ipad[i]^=key[i]; opad[i]^=key[i]; }
  var state: array<u32,8>; sha256_init(&state); sha256_block(&state,ipad);
  var w2: array<u32,16>;
  for (var i=0u; i<5u; i++) { w2[i]=msg20[i]; }
  sha256_finalize_1block(&state,w2,81u);
  return sha256_64plus32(opad,state);
}
const EXTRACT_INNER = ${wgslU32Array(states.inner)};
const EXTRACT_OUTER = ${wgslU32Array(states.outer)};
const INFO_WORD0 = ${((i) => (i[0] << 24) | (i[1] << 16) | (i[2] << 8) | i[3])(info) >>> 0}u;
const INFO_WORD1 = ${((i) => (i[4] << 24) | (i[5] << 16) | (i[6] << 8) | i[7])(info) >>> 0}u;
const INFO_WORD2 = ${((i) => (i[8] << 24) | (i[9] << 16) | (i[10] << 8) | i[11])(info) >>> 0}u;
const INFO_WORD3 = ${((i) => (i[12] << 24) | (i[13] << 16) | (i[14] << 8) | i[15])(info) >>> 0}u;
const BLOB_PADDING : u32 = ${padding}u;
fn hkdf_extract(ikm: array<u32,2>) -> array<u32,8> {
  // Local copies are required for function-address-space pointers.
  var inner = EXTRACT_INNER; var outer = EXTRACT_OUTER;
  var message: array<u32,16>;
  message[0]=ikm[0]; message[1]=ikm[1]; message[2]=0x80000000u; message[15]=576u;
  sha256_block(&inner,message);
  var tail: array<u32,16>;
  for(var i=0u; i<8u; i++){ tail[i]=inner[i]; }
  tail[8]=0x80000000u; tail[15]=768u;
  sha256_block(&outer,tail);
  return outer;
}
fn hkdf_expand_16(prk: array<u32,8>) -> array<u32,4> {
  var msg: array<u32,5>;
  msg[0]=INFO_WORD0; msg[1]=INFO_WORD1; msg[2]=INFO_WORD2; msg[3]=INFO_WORD3; msg[4]=0x01000000u;
  let t1=hmac_sha256_key32_msg20(prk,msg);
  return array<u32,4>(t1[0],t1[1],t1[2],t1[3]);
}
const SBOX = array<u32,256>(
  0x63u,0x7cu,0x77u,0x7bu,0xf2u,0x6bu,0x6fu,0xc5u,0x30u,0x01u,0x67u,0x2bu,0xfeu,0xd7u,0xabu,0x76u,
  0xcau,0x82u,0xc9u,0x7du,0xfau,0x59u,0x47u,0xf0u,0xadu,0xd4u,0xa2u,0xafu,0x9cu,0xa4u,0x72u,0xc0u,
  0xb7u,0xfdu,0x93u,0x26u,0x36u,0x3fu,0xf7u,0xccu,0x34u,0xa5u,0xe5u,0xf1u,0x71u,0xd8u,0x31u,0x15u,
  0x04u,0xc7u,0x23u,0xc3u,0x18u,0x96u,0x05u,0x9au,0x07u,0x12u,0x80u,0xe2u,0xebu,0x27u,0xb2u,0x75u,
  0x09u,0x83u,0x2cu,0x1au,0x1bu,0x6eu,0x5au,0xa0u,0x52u,0x3bu,0xd6u,0xb3u,0x29u,0xe3u,0x2fu,0x84u,
  0x53u,0xd1u,0x00u,0xedu,0x20u,0xfcu,0xb1u,0x5bu,0x6au,0xcbu,0xbeu,0x39u,0x4au,0x4cu,0x58u,0xcfu,
  0xd0u,0xefu,0xaau,0xfbu,0x43u,0x4du,0x33u,0x85u,0x45u,0xf9u,0x02u,0x7fu,0x50u,0x3cu,0x9fu,0xa8u,
  0x51u,0xa3u,0x40u,0x8fu,0x92u,0x9du,0x38u,0xf5u,0xbcu,0xb6u,0xdau,0x21u,0x10u,0xffu,0xf3u,0xd2u,
  0xcdu,0x0cu,0x13u,0xecu,0x5fu,0x97u,0x44u,0x17u,0xc4u,0xa7u,0x7eu,0x3du,0x64u,0x5du,0x19u,0x73u,
  0x60u,0x81u,0x4fu,0xdcu,0x22u,0x2au,0x90u,0x88u,0x46u,0xeeu,0xb8u,0x14u,0xdeu,0x5eu,0x0bu,0xdbu,
  0xe0u,0x32u,0x3au,0x0au,0x49u,0x06u,0x24u,0x5cu,0xc2u,0xd3u,0xacu,0x62u,0x91u,0x95u,0xe4u,0x79u,
  0xe7u,0xc8u,0x37u,0x6du,0x8du,0xd5u,0x4eu,0xa9u,0x6cu,0x56u,0xf4u,0xeau,0x65u,0x7au,0xaeu,0x08u,
  0xbau,0x78u,0x25u,0x2eu,0x1cu,0xa6u,0xb4u,0xc6u,0xe8u,0xddu,0x74u,0x1fu,0x4bu,0xbdu,0x8bu,0x8au,
  0x70u,0x3eu,0xb5u,0x66u,0x48u,0x03u,0xf6u,0x0eu,0x61u,0x35u,0x57u,0xb9u,0x86u,0xc1u,0x1du,0x9eu,
  0xe1u,0xf8u,0x98u,0x11u,0x69u,0xd9u,0x8eu,0x94u,0x9bu,0x1eu,0x87u,0xe9u,0xceu,0x55u,0x28u,0xdfu,
  0x8cu,0xa1u,0x89u,0x0du,0xbfu,0xe6u,0x42u,0x68u,0x41u,0x99u,0x2du,0x0fu,0xb0u,0x54u,0xbbu,0x16u
);
const INV_SBOX = array<u32,256>(
  0x52u,0x09u,0x6au,0xd5u,0x30u,0x36u,0xa5u,0x38u,0xbfu,0x40u,0xa3u,0x9eu,0x81u,0xf3u,0xd7u,0xfbu,
  0x7cu,0xe3u,0x39u,0x82u,0x9bu,0x2fu,0xffu,0x87u,0x34u,0x8eu,0x43u,0x44u,0xc4u,0xdeu,0xe9u,0xcbu,
  0x54u,0x7bu,0x94u,0x32u,0xa6u,0xc2u,0x23u,0x3du,0xeeu,0x4cu,0x95u,0x0bu,0x42u,0xfau,0xc3u,0x4eu,
  0x08u,0x2eu,0xa1u,0x66u,0x28u,0xd9u,0x24u,0xb2u,0x76u,0x5bu,0xa2u,0x49u,0x6du,0x8bu,0xd1u,0x25u,
  0x72u,0xf8u,0xf6u,0x64u,0x86u,0x68u,0x98u,0x16u,0xd4u,0xa4u,0x5cu,0xccu,0x5du,0x65u,0xb6u,0x92u,
  0x6cu,0x70u,0x48u,0x50u,0xfdu,0xedu,0xb9u,0xdau,0x5eu,0x15u,0x46u,0x57u,0xa7u,0x8du,0x9du,0x84u,
  0x90u,0xd8u,0xabu,0x00u,0x8cu,0xbcu,0xd3u,0x0au,0xf7u,0xe4u,0x58u,0x05u,0xb8u,0xb3u,0x45u,0x06u,
  0xd0u,0x2cu,0x1eu,0x8fu,0xcau,0x3fu,0x0fu,0x02u,0xc1u,0xafu,0xbdu,0x03u,0x01u,0x13u,0x8au,0x6bu,
  0x3au,0x91u,0x11u,0x41u,0x4fu,0x67u,0xdcu,0xeau,0x97u,0xf2u,0xcfu,0xceu,0xf0u,0xb4u,0xe6u,0x73u,
  0x96u,0xacu,0x74u,0x22u,0xe7u,0xadu,0x35u,0x85u,0xe2u,0xf9u,0x37u,0xe8u,0x1cu,0x75u,0xdfu,0x6eu,
  0x47u,0xf1u,0x1au,0x71u,0x1du,0x29u,0xc5u,0x89u,0x6fu,0xb7u,0x62u,0x0eu,0xaau,0x18u,0xbeu,0x1bu,
  0xfcu,0x56u,0x3eu,0x4bu,0xc6u,0xd2u,0x79u,0x20u,0x9au,0xdbu,0xc0u,0xfeu,0x78u,0xcdu,0x5au,0xf4u,
  0x1fu,0xddu,0xa8u,0x33u,0x88u,0x07u,0xc7u,0x31u,0xb1u,0x12u,0x10u,0x59u,0x27u,0x80u,0xecu,0x5fu,
  0x60u,0x51u,0x7fu,0xa9u,0x19u,0xb5u,0x4au,0x0du,0x2du,0xe5u,0x7au,0x9fu,0x93u,0xc9u,0x9cu,0xefu,
  0xa0u,0xe0u,0x3bu,0x4du,0xaeu,0x2au,0xf5u,0xb0u,0xc8u,0xebu,0xbbu,0x3cu,0x83u,0x53u,0x99u,0x61u,
  0x17u,0x2bu,0x04u,0x7eu,0xbau,0x77u,0xd6u,0x26u,0xe1u,0x69u,0x14u,0x63u,0x55u,0x21u,0x0cu,0x7du
);
fn gmul2(x: u32) -> u32 { return select((x<<1u)^0x1bu,x<<1u,(x&0x80u)==0u)&0xffu; }
fn gmul9(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^x; }
fn gmulb(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^gmul2(x)^x; }
fn gmuld(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^gmul2(gmul2(x))^x; }
fn gmule(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^gmul2(gmul2(x))^gmul2(x); }
fn inv_sub_bytes(state: ptr<function,array<u32,4>>) {
  for (var c=0u; c<4u; c++) {
    let s=(*state)[c];
    (*state)[c]=(INV_SBOX[(s>>24u)&0xffu]<<24u)|(INV_SBOX[(s>>16u)&0xffu]<<16u)|
                (INV_SBOX[(s>>8u)&0xffu]<<8u)|INV_SBOX[s&0xffu];
  }
}
fn inv_shift_rows(state: ptr<function,array<u32,4>>) {
  let u0=(*state)[0]; let u1=(*state)[1]; let u2=(*state)[2]; let u3=(*state)[3];
  let b00=(u0>>24u)&0xffu; let b01=(u1>>24u)&0xffu; let b02=(u2>>24u)&0xffu; let b03=(u3>>24u)&0xffu;
  let b10=(u0>>16u)&0xffu; let b11=(u1>>16u)&0xffu; let b12=(u2>>16u)&0xffu; let b13=(u3>>16u)&0xffu;
  let b20=(u0>>8u)&0xffu;  let b21=(u1>>8u)&0xffu;  let b22=(u2>>8u)&0xffu;  let b23=(u3>>8u)&0xffu;
  let b30=u0&0xffu;        let b31=u1&0xffu;        let b32=u2&0xffu;        let b33=u3&0xffu;
  (*state)[0]=(b00<<24u)|(b13<<16u)|(b22<<8u)|b31;
  (*state)[1]=(b01<<24u)|(b10<<16u)|(b23<<8u)|b32;
  (*state)[2]=(b02<<24u)|(b11<<16u)|(b20<<8u)|b33;
  (*state)[3]=(b03<<24u)|(b12<<16u)|(b21<<8u)|b30;
}
fn inv_mix_col(s: u32) -> u32 {
  let a0=(s>>24u)&0xffu; let a1=(s>>16u)&0xffu; let a2=(s>>8u)&0xffu; let a3=s&0xffu;
  return ((gmule(a0)^gmulb(a1)^gmuld(a2)^gmul9(a3))<<24u)|
         ((gmul9(a0)^gmule(a1)^gmulb(a2)^gmuld(a3))<<16u)|
         ((gmuld(a0)^gmul9(a1)^gmule(a2)^gmulb(a3))<<8u)|
         (gmulb(a0)^gmuld(a1)^gmul9(a2)^gmule(a3));
}
fn inv_mix_columns(state: ptr<function,array<u32,4>>) {
  for (var c=0u; c<4u; c++) { (*state)[c]=inv_mix_col((*state)[c]); }
}
fn aes128_key_schedule(key: array<u32,4>) -> array<u32,44> {
  var rk: array<u32,44>;
  rk[0]=key[0]; rk[1]=key[1]; rk[2]=key[2]; rk[3]=key[3];
  let rcon=array<u32,10>(0x01000000u,0x02000000u,0x04000000u,0x08000000u,0x10000000u,
                          0x20000000u,0x40000000u,0x80000000u,0x1b000000u,0x36000000u);
  for (var i=4u; i<44u; i++) {
    var tmp=rk[i-1u];
    if ((i&3u)==0u) {
      tmp=(tmp<<8u)|(tmp>>24u);
      tmp=(SBOX[(tmp>>24u)&0xffu]<<24u)|(SBOX[(tmp>>16u)&0xffu]<<16u)|
          (SBOX[(tmp>>8u)&0xffu]<<8u)|SBOX[tmp&0xffu];
      tmp^=rcon[(i>>2u)-1u];
    }
    rk[i]=rk[i-4u]^tmp;
  }
  return rk;
}
fn aes128_dec_block(rk: array<u32,44>, ct: array<u32,4>) -> array<u32,4> {
  var state=ct;
  for (var c=0u; c<4u; c++) { state[c]^=rk[40u+c]; }
  for (var round=9u; round>=1u; round--) {
    inv_shift_rows(&state); inv_sub_bytes(&state);
    for (var c=0u; c<4u; c++) { state[c]^=rk[round*4u+c]; }
    inv_mix_columns(&state);
  }
  inv_shift_rows(&state); inv_sub_bytes(&state);
  for (var c=0u; c<4u; c++) { state[c]^=rk[c]; }
  return state;
}
const CBC_PAIR : array<u32,8> = ${wgslU32Array(cbcPairWords)};
fn build_uuid(counter: u32) -> array<u32,2> {
  var uuid: array<u32,2>;
  var xIdx: u32=0u; var w0: u32=0u; var w1: u32=0u;
  for (var n=0u; n<16u; n++) {
    var nib: u32;
    if ((UUID_XMASK&(1u<<n))!=0u) {
      let shift=(UUID_UNK_CNT-1u-xIdx)*4u; nib=(counter>>shift)&0xfu; xIdx++;
    } else {
      if (n<8u) { nib=(params.fixedWord0>>((7u-n)*4u))&0xfu; }
      else      { nib=(params.fixedWord1>>((15u-n)*4u))&0xfu; }
    }
    let byteIdx=n>>1u; let isUpper=(n&1u)==0u;
    if (byteIdx<4u) {
      if (isUpper) { w0|=(nib<<((3u-byteIdx)*8u+4u)); } else { w0|=(nib<<((3u-byteIdx)*8u)); }
    } else {
      let b=byteIdx-4u;
      if (isUpper) { w1|=(nib<<((3u-b)*8u+4u)); } else { w1|=(nib<<((3u-b)*8u)); }
    }
  }
  uuid[0]=w0; uuid[1]=w1; return uuid;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i=gid.x;
  if (i>=params.batchCount) { return; }
  let counter=params.batchStart+i;
  let uuid=build_uuid(counter);
  let prk=hkdf_extract(uuid);
  let aes_key=hkdf_expand_16(prk);
  let rk=aes128_key_schedule(aes_key);
  var ct_last: array<u32,4>;
  ct_last[0]=CBC_PAIR[4u]; ct_last[1]=CBC_PAIR[5u]; ct_last[2]=CBC_PAIR[6u]; ct_last[3]=CBC_PAIR[7u];
  var chain_prev: array<u32,4>;
  chain_prev[0]=CBC_PAIR[0u]; chain_prev[1]=CBC_PAIR[1u]; chain_prev[2]=CBC_PAIR[2u]; chain_prev[3]=CBC_PAIR[3u];
  var pt_last: array<u32,4>;
  let dec_last=aes128_dec_block(rk,ct_last);
  for (var c=0u; c<4u; c++) { pt_last[c]=dec_last[c]^chain_prev[c]; }
  if (BLOB_PADDING==0u||BLOB_PADDING>16u) { return; }
  var all_zero: bool=true;
  let check_start: u32=16u-BLOB_PADDING;
  for (var p=check_start; p<16u; p++) {
    let word=pt_last[p>>2u];
    let byte_val=(word>>(24u-(p&3u)*8u))&0xffu;
    if (byte_val!=0u) { all_zero=false; }
  }
  if (all_zero) {
    let slot=atomicAdd(&hits[0],1u);
    if (slot<${MAX_HITS}u) { atomicStore(&hits[slot+1u],counter); }
  }
}
`;
    }

    const api = { prepareExtractStates, buildOptimizedShader, revision: 'midstate64-v1' };
    globalThis.CoreFlasherUuidOptimized = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
