import React from 'react';
const text:Record<string,{heading:string;description:string}>={
 NONE:{heading:'尚无模型用量记录',description:'当前未查到本次运行的模型账目，供应商账单尚未核验。'},
 PENDING:{heading:'模型费用记录待完成',description:'部分用量或费用记录尚未处理完毕，当前记录不是最终账单。'},
 UNKNOWN:{heading:'模型费用待核对',description:'存在未核实的用量或费用，不能按零费用处理。请管理员核对，核实前请勿重复提交相同请求。'},
 RECORDED:{heading:'模型费用记录已处理',description:'本地用量记录已处理，供应商账单尚未核验。'}
};
export function ModelAccounting({value}:{value:unknown}){
 const row=value&&typeof value==='object'?value as Record<string,unknown>:null,status=row?.status;
 if(!row||typeof status!=='string'||!Object.hasOwn(text,status)||!Number.isSafeInteger(row.requestCount)||Number(row.requestCount)<0||typeof row.heldReservation!=='boolean'||typeof row.legacyUnmetered!=='boolean'||row.providerInvoiceVerified!==false||(status==='NONE')!==(row.requestCount===0))return <aside aria-label="模型费用记录"><p>模型费用记录暂不可用，请重新查看；供应商账单尚未核验。</p></aside>;
 const current=text[status]!,reasons=Array.isArray(row.reasons)?row.reasons:[];
 return <aside aria-label="模型费用记录"><h4>{current.heading}</h4><p>{current.description}</p><p>共 {String(row.requestCount)} 条请求记录。</p>{row.heldReservation&&<p>账本中的相关预算预留仍待核对或结算。</p>}{status==='UNKNOWN'&&reasons.includes('TARIFF_UNCONFIRMED')&&<p>用量已有记录，计价依据尚未核实。</p>}{status==='UNKNOWN'&&reasons.includes('DISPATCH_UNCONFIRMED')&&<p>原请求状态仍需核对，请勿重新发送。</p>}{row.legacyUnmetered&&<p>包含计量不完整的历史记录，不能据此认定没有费用。</p>}</aside>;
}
