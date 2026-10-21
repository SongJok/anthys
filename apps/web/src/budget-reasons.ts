const scopes:Record<string,string>={TENANT:'企业',GROUP:'群',DEPARTMENT:'部门',USER:'个人',TASK:'任务'};
const configured='模型预算配置需要管理员确认，任务已暂停。';
export const budgetReasons:Record<string,string>={
 GROUP_CONTRACT_CHANGED:'群授权合同或其审核依据已变化，任务已停止；请管理员核对当前合同，既有未知费用仍保留额度。',
 GROUP_CONTRACT_EXPIRED:'群授权合同已到期，任务已停止；不会自动恢复或发送，既有未知费用仍保留额度。',
 GROUP_CONTRACT_STOPPED:'当前群授权合同不允许继续处理，任务已停止；请管理员核对合同与授权依据。',
 GROUP_CONTRACT_BUDGET_CURRENCY_MISMATCH:'群合同与当前模型预算的币种不一致，任务已停止；请管理员核对。',
 ACTIVE_TIME_BUDGET_EXHAUSTED:'累计处理时间已达到上限，任务已暂停；等待审批的时间未计入。',
 LEGACY_ACTIVE_TIME_UNVERIFIED:'历史处理用量无法核实，已暂停，请管理员核对。',
 INVALID_RUNTIME_BUDGET:'任务预算配置未通过检查，请管理员核对。',
 MODEL_INPUT_BUDGET_EXHAUSTED:'本轮资料量超过允许上限，任务已暂停。',
 MODEL_CONCURRENCY_LIMIT:'当前模型处理名额已满，任务正在等待恢复。',
 MODEL_RUN_REQUEST_IN_PROGRESS:'上一请求仍在处理中，任务正在等待恢复。',
 MODEL_USAGE_OUTSIDE_RESERVATION:'模型用量超出预留范围，已暂停后续请求，请管理员核对费用。',
 MODEL_CACHE_TARIFF_UNCONFIRMED:'缓存计价依据尚未确认，无法核实模型费用；未知费用仍保留预留额度，请管理员核对缓存费率与计费凭据，核对前请勿重试或重复扣费。',
 MODEL_CACHED_USAGE_INVALID:'缓存用量数据异常，无法据此核实模型费用；未知费用仍保留预留额度，请管理员核对缓存用量与总输入用量，核对前请勿重试或重复扣费。',
 MODEL_USAGE_UNAVAILABLE:'模型用量缺失或数据不一致，费用尚未核实；未知费用仍保留预留额度，请管理员核对服务商用量记录，核对前请勿重试或重复扣费。',
 SETTLED_MODEL_COST_CANNOT_BE_RELEASED:'已有模型用量或费用结算记录，不能按未发送请求释放额度；请管理员核对发送状态与结算凭据，费用未知部分仍保留预留额度，核对前请勿重试或重复扣费。',
 LEGACY_MODEL_COST_RECONCILIATION_REQUIRED:'既有模型费用尚未核对，后续请求已暂停，请管理员处理。',
 MODEL_BUDGET_POLICY_UNCONFIGURED:configured,MODEL_BUDGET_POLICY_INVALID:configured,MODEL_BUDGET_POLICY_EXPIRED:configured,MODEL_BUDGET_POLICY_VERSION_MISMATCH:configured,MODEL_BUDGET_POLICY_BLOCKED:configured,
 ...Object.fromEntries(Object.entries(scopes).flatMap(([code,label])=>['TOKEN','MONEY'].map(kind=>['MODEL_'+kind+'_BUDGET_EXHAUSTED_'+code,label+'模型'+(kind==='TOKEN'?'用量':'费用')+'额度不足，任务已暂停；尚未确认的既有用量仍保留额度。'])))
};
