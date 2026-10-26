---
impacto: capacidade_nova
secao: adicionado
titulo: Automação e fluxo de follow-up agora removem e trocam tags
---
As automações ganharam a ação "Remover tag", espelho de "Adicionar tag": tira do negócio (ou do contato, se escolhido) as tags informadas, sem diferenciar maiúsculas nem espaços nas pontas, e ignora a tag que não estiver lá. Com as duas ações em sequência, a regra troca uma tag por outra (por exemplo, tira `1o-trimestre` e põe `2o-trimestre`). No fluxo de follow-up, a caixa "Editar tag do lead" ganhou o campo "Tags para tirar do lead": as de baixo saem primeiro e as de cima entram depois. Fluxos e regras que já existem continuam iguais. A remoção acontece numa única operação no banco, então duas automações rodando ao mesmo tempo no mesmo negócio não apagam o trabalho uma da outra. A atualização cria duas funções no banco; nada a fazer à mão.
