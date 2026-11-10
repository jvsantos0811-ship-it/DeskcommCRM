/**
 * O PDF DO CONTRATO GERADO PELO MODELO (PC-030, item 2).
 *
 * Só o texto do escritório, já com os dados do cliente, em A4. Sem marca do
 * revendedor: o contrato é do escritório (controlador), e o nome dele já está
 * no próprio texto aprovado pelo advogado. O rodapé diz de qual versão do
 * modelo o arquivo saiu — é o que a equipe confere quando o cliente reclama.
 */
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import React from "react";

const estilos = StyleSheet.create({
  pagina: { paddingTop: 48, paddingBottom: 56, paddingHorizontal: 56, fontSize: 10.5, lineHeight: 1.5 },
  titulo: { fontSize: 14, fontWeight: 700, textAlign: "center", marginBottom: 18 },
  paragrafo: { marginBottom: 8, textAlign: "justify" },
  rodape: { position: "absolute", bottom: 24, left: 56, right: 56, fontSize: 7.5, color: "#666" },
});

export interface ContratoPdfInput {
  titulo: string;
  texto: string;
  /** "Modelo X, versão N" — vai no rodapé. */
  origem: string;
}

function ContratoPdf({ d }: { d: ContratoPdfInput }): React.ReactElement {
  const paragrafos = d.texto.split(/\n{2,}|\r\n\r\n/).flatMap((bloco) => bloco.split("\n"));
  return (
    <Document title={d.titulo}>
      <Page size="A4" style={estilos.pagina}>
        <Text style={estilos.titulo}>{d.titulo}</Text>
        <View>
          {paragrafos.map((p, i) => (
            <Text key={i} style={estilos.paragrafo}>
              {p.trim() === "" ? " " : p}
            </Text>
          ))}
        </View>
        <Text
          style={estilos.rodape}
          fixed
          render={({ pageNumber, totalPages }) => `${d.origem} · página ${pageNumber} de ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

export async function pdfDoContrato(d: ContratoPdfInput): Promise<Buffer> {
  return renderToBuffer(<ContratoPdf d={d} />);
}
