// Acceso remoto F0 (docs/_experiments/remote-control/CONTRACT.md §1.4): identidad TLS PROPIA de esta PC.
//
// Certificado autofirmado, nunca pasa por una autoridad publica ni por ningun registro de Certificate
// Transparency -- el usuario rechazo `tailscale serve` justamente por eso. El telefono no "confia" en el
// certificado por una CA: FIJA (pinning) el hash SHA-256 de la clave publica (SPKI), que recibe por el QR
// que ve en su propia pantalla. Por eso la CLAVE es lo que persiste; el certificado se re-emite en cada
// arranque con las IPs actuales de la PC en el SAN (si la IP cambia por DHCP, el pin sigue valiendo).
//
// Node genera claves pero no emite certificados X.509 -- en vez de sumar una dependencia, un codificador DER
// minimo (ECDSA P-256, X.509 v3) verificado con crypto.X509Certificate().verify() de Node.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import path from 'node:path'
import { safeStorage } from 'electron'
import { getAppDataSubdir } from './app-paths'

// ---- codificador DER minimo ----
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8 }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag: number, content: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items))
const explicit = (n: number, content: Buffer): Buffer => tlv(0xa0 + n, content)
function derInteger(value: Buffer): Buffer {
  let v = value
  while (v.length > 1 && v[0] === 0 && (v[1] & 0x80) === 0) v = v.subarray(1)
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v])
  return tlv(0x02, v)
}
function derOid(oid: string): Buffer {
  const parts = oid.split('.').map(Number)
  const out = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f]
    let rest = part >> 7
    while (rest > 0) { stack.unshift((rest & 0x7f) | 0x80); rest >>= 7 }
    out.push(...stack)
  }
  return tlv(0x06, Buffer.from(out))
}
const derUtf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
function derUtcTime(d: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0')
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(s, 'ascii'))
}
const derBitString = (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content]))
const derOctetString = (content: Buffer): Buffer => tlv(0x04, content)
const DER_TRUE = tlv(0x01, Buffer.from([0xff]))

const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_COMMON_NAME = '2.5.4.3'

function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split('.').map(Number))
  // IPv6 expandido a 16 bytes (solo para el SAN; el servidor de F0 escucha en IPv4 de red local)
  const [head, tail = ''] = ip.split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return Buffer.concat(groups.map(g => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(g || '0', 16)); return b }))
}

/** Emite un certificado X.509 v3 autofirmado para `addresses` (IPs o nombres) con la clave dada. */
export function issueSelfSignedCertificate(privateKey: KeyObject, addresses: string[], commonName = 'Amatista (acceso remoto)'): string {
  const publicKey = createPublicKey(privateKey)
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const name = seq(set(seq(derOid(OID_COMMON_NAME), derUtf8(commonName))))
  const now = Date.now()
  const altNames = addresses.map(a => isIP(a) ? tlv(0x87, ipBytes(a)) : tlv(0x82, Buffer.from(a, 'ascii')))
  const extensions = seq(
    seq(derOid('2.5.29.17'), derOctetString(seq(...altNames))), // subjectAltName
    seq(derOid('2.5.29.19'), DER_TRUE, derOctetString(seq())), // basicConstraints: CA:false (critica)
    seq(derOid('2.5.29.15'), DER_TRUE, derOctetString(tlv(0x03, Buffer.from([0x07, 0x80])))), // keyUsage: digitalSignature
    seq(derOid('2.5.29.37'), derOctetString(seq(derOid('1.3.6.1.5.5.7.3.1')))) // extKeyUsage: serverAuth
  )
  const algorithm = seq(derOid(OID_ECDSA_SHA256))
  const tbs = seq(
    explicit(0, derInteger(Buffer.from([2]))), // v3
    derInteger(randomBytes(16)),
    algorithm,
    name,
    seq(derUtcTime(new Date(now - 24 * 3600 * 1000)), derUtcTime(new Date(now + 5 * 365 * 24 * 3600 * 1000))),
    name,
    spki,
    explicit(3, extensions)
  )
  const signature = sign('sha256', tbs, privateKey) // ECDSA: firma DER por default
  const der = seq(tbs, algorithm, derBitString(signature))
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----\n`
  // Autocomprobacion: si el codificador produjera algo que Node no puede parsear o verificar, mejor fallar aca.
  const parsed = new X509Certificate(pem)
  if (!parsed.verify(publicKey)) throw new Error('El certificado autofirmado generado no verifica con su propia clave.')
  return pem
}

/** Pin del telefono: SHA-256 de la clave publica (SubjectPublicKeyInfo), base64url -- el mismo criterio que el
 *  `<pin digest="SHA-256">` de Android (network security config). */
export function spkiPin(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64url')
}

export interface RemoteIdentity {
  privateKey: KeyObject
  keyPem: string
  pin: string
  /** true = clave persistida cifrada (safeStorage); false = clave solo en memoria (sin cifrado disponible en esta
   *  plataforma): vale mientras la app siga abierta, los dispositivos tendran que volver a emparejarse al reiniciar. */
  persistent: boolean
}

interface IdentityFile { version: 1; createdAt: string; encryptedKey: string }

function identityFile(): string {
  return process.env.AMATISTA_REMOTE_IDENTITY_FILE?.trim() || path.join(getAppDataSubdir('config'), 'remote-identity.json')
}

let cached: RemoteIdentity | null = null

/** Clave de identidad de esta PC: se genera UNA vez y se guarda cifrada con safeStorage (DPAPI en Windows, el
 *  mismo mecanismo que las API keys). Nunca se escribe en claro: sin cifrado disponible queda solo en memoria. */
export function loadOrCreateRemoteIdentity(): RemoteIdentity {
  if (cached) return cached
  const file = identityFile()
  const canEncrypt = safeStorage.isEncryptionAvailable()
  if (canEncrypt && existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as IdentityFile
      const keyPem = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'))
      const privateKey = createPrivateKey(keyPem)
      cached = { privateKey, keyPem, pin: spkiPin(createPublicKey(privateKey)), persistent: true }
      return cached
    } catch {
      // Archivo ilegible o de otra cuenta de Windows (DPAPI): se aparta con fecha, nunca se pisa en silencio.
      try { renameSync(file, `${file}.ilegible-${Date.now()}`) } catch { /* sin permiso: se sigue igual */ }
    }
  }
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  if (canEncrypt) {
    const data: IdentityFile = { version: 1, createdAt: new Date().toISOString(), encryptedKey: safeStorage.encryptString(keyPem).toString('base64') }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  }
  cached = { privateKey, keyPem, pin: spkiPin(createPublicKey(privateKey)), persistent: canEncrypt }
  return cached
}

/** Solo para tests: olvida la identidad en memoria (el archivo, si existe, queda). */
export function resetRemoteIdentityCacheForTests(): void {
  cached = null
}
