/**
 * 暴露给模型的工具 schema。与 registry 的工具名一一对应，不多不少。
 * 参数只描述结构，不携带任何业务规则——规则在工具层代码里。
 */

export const T = {
  queryBalance: {
    type: 'function',
    function: {
      name: 'query_balance',
      description: '查询当前用户本人活期账户余额',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  billAnalyze: {
    type: 'function',
    function: {
      name: 'bill_analyze',
      description: '分析本人近 N 天消费：分类汇总、Top 商户、异常交易',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '统计天数，默认 30', minimum: 1, maximum: 365 },
        },
        additionalProperties: false,
      },
    },
  },
  transferCreate: {
    type: 'function',
    function: {
      name: 'transfer_create',
      description: '向通讯录内收款人转账（金额单位为分）',
      parameters: {
        type: 'object',
        properties: {
          payee: { type: 'string', description: '收款人姓名或手机号，必须已在通讯录' },
          amountCents: { type: 'integer', description: '金额，单位：分' },
          memo: { type: 'string', description: '备注，可为空' },
        },
        required: ['payee', 'amountCents'],
        additionalProperties: false,
      },
    },
  },
  subscriptionList: {
    type: 'function',
    function: {
      name: 'subscription_list',
      description: '列出本人订阅代扣',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
};
