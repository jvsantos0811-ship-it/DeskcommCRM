/**
 * A ORIGEM ESTÁ NA LISTA DA CHAVE?
 *
 * `lib/http/ip-do-cliente.ts` avisa que o IP do cabeçalho não é prova de origem
 * quando ninguém na frente o confere. Aqui ele DECIDE, e a decisão é segura só
 * porque, na instalação:
 *
 *   - o app não publica porta (`tests/unit/portas-do-compose.test.ts`): toda
 *     requisição de fora passa pelo Caddy;
 *   - o Caddy SUBSTITUI o `x-forwarded-for` recebido pelo endereço do socket
 *     (ele não confia no cabeçalho de quem chega sem `trusted_proxies`);
 *   - no modo túnel, `IP_DO_CLIENTE_HEADER=cf-connecting-ip`, que a borda da
 *     Cloudflare sobrescreve.
 *
 * Por isso esta trava é SOMADA à chave, nunca no lugar dela: sem a chave nada
 * passa, e com a chave vazada fora da faixa da Anthropic também não.
 *
 * Sem IP conhecido, ou com lista vazia: RECUSA. A falha é fechada.
 */
import { BlockList, isIP } from "node:net";

function semPrefixoMapeado(ip: string): string {
  // `::ffff:160.79.104.10` é o IPv4 visto por um socket IPv6.
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

export function ipEstaNaLista(ip: string | null | undefined, cidrs: readonly string[] | null | undefined): boolean {
  if (!ip || !cidrs || cidrs.length === 0) return false;
  const limpo = semPrefixoMapeado(ip.trim());
  const versao = isIP(limpo);
  if (versao === 0) return false;
  const familia = versao === 4 ? "ipv4" : "ipv6";

  const lista = new BlockList();
  for (const bruto of cidrs) {
    const [endereco, prefixoTxt] = bruto.trim().split("/");
    if (!endereco) continue;
    const v = isIP(endereco);
    if (v === 0) continue;
    const fam = v === 4 ? "ipv4" : "ipv6";
    const max = v === 4 ? 32 : 128;
    const prefixo = prefixoTxt === undefined ? max : Number(prefixoTxt);
    if (!Number.isInteger(prefixo) || prefixo < 0 || prefixo > max) continue;
    lista.addSubnet(endereco, prefixo, fam);
  }
  return lista.check(limpo, familia);
}

/** Valida e normaliza uma lista digitada na tela (um CIDR ou IP por item). */
export function normalizarListaDeIps(entrada: readonly string[]): { ok: string[] } | { invalido: string } {
  const ok: string[] = [];
  for (const bruto of entrada) {
    const item = bruto.trim();
    if (!item) continue;
    const [endereco, prefixoTxt] = item.split("/");
    const v = endereco ? isIP(endereco) : 0;
    if (v === 0) return { invalido: item };
    const max = v === 4 ? 32 : 128;
    const prefixo = prefixoTxt === undefined ? max : Number(prefixoTxt);
    if (!Number.isInteger(prefixo) || prefixo < 0 || prefixo > max) return { invalido: item };
    ok.push(`${endereco}/${prefixo}`);
  }
  return ok.length > 0 ? { ok } : { invalido: "" };
}
