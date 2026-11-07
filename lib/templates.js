// dsh-mesh: plan templates for the four recurring shapes.
//
// A template is just a step list; it is returned to the caller (mesh_plan) and
// can be passed straight to mesh_submit. Instructions are deliberately explicit
// about inputs/outputs so a worker turn can run without extra context.

function cleanGoal(goal) {
  return String(goal || '').trim() || '（未指定目标）';
}

function asList(value, fallback) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    if (items.length) return items;
  }
  if (typeof value === 'string' && value.trim()) {
    const items = value
      .split(/[\n,，;；]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (items.length) return items;
  }
  return fallback;
}

function repeated(prefix, count, fallback) {
  const total = Math.max(1, Math.min(40, Number(count) || fallback));
  return Array.from({ length: total }, (_, index) => `${prefix}${index + 1}`);
}

// research -> document (report / paper / analysis)
function researchTemplate(args) {
  const goal = cleanGoal(args.goal);
  const sections = asList(args.sections || args.topics, repeated('第', args.count || 6, 6)).map((item, index) =>
    /^\d+$/.test(item) ? `第${item}部分` : item,
  );
  const material = String(args.material || '').trim();
  const target = String(args.target || '').trim() || '6000 字';
  const steps = [];
  steps.push({
    id: 's0',
    title: '提纲与素材清单',
    priority: 10,
    instruction: [
      `目标是：${goal}。`,
      material ? `可参考的本地素材目录：${material}` : '',
      `请先列出全文大纲：分成 ${sections.length} 个部分，每部分给出标题、要论证的核心命题、需要的证据/法条/数据。`,
      '同时列出还需要补充检索的要点。只输出大纲，不要展开正文。',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const bodyIds = [];
  sections.forEach((section, index) => {
    const id = `s${index + 1}`;
    bodyIds.push(id);
    steps.push({
      id,
      title: section,
      dependsOn: ['s0'],
      priority: 50,
      instruction: [
        `全文目标：${goal}`,
        `全文提纲：\n{{step:s0}}`,
        `现在只写「${section}」这一部分，约 ${Math.max(800, Math.round(Number(String(target).replace(/[^\d]/g, '')) / sections.length) || 1500)} 字。`,
        material ? `可查阅素材目录：${material}；引用必须来自其中真实存在的条文/文献，不得虚构。` : '引用必须真实，不得虚构出处。',
        '要求：论证有层次、有学理依据，避免空话与套话；只输出该部分正文。',
      ].join('\n\n'),
    });
  });
  steps.push({
    id: 'review',
    title: '引用与事实核验',
    dependsOn: bodyIds,
    priority: 80,
    serial: true,
    instruction: [
      '下面是各部分初稿。请逐段核验：',
      '1) 每一处引用/法条/数据是否真实可查，无法确认的标注出来并给出处理建议；',
      '2) 逻辑矛盾、重复论证、与主题无关的段落；',
      '3) 输出一份「问题清单 + 逐条修改指令」，不要重写全文。',
      '',
      bodyIds.map((id) => `### ${id}\n{{step:${id}}}`).join('\n\n'),
    ].join('\n'),
  });
  steps.push({
    id: 'style',
    title: '文风统一（去除 AI 腔）',
    dependsOn: ['review'],
    priority: 90,
    serial: true,
    instruction: [
      '把下列内容统一成一位资深研究者本人的笔调：',
      '- 删掉「首先/其次/最后」「综上所述」「值得注意的是」这类模板腔；',
      '- 不要排比堆砌、不要空泛形容词；句子长短交错，允许不完全对称；',
      '- 保留全部实质内容与引用，但修正被核验标出的问题。',
      '',
      '问题清单：\n{{step:review}}',
      '',
      bodyIds.map((id) => `### ${id}\n{{step:${id}}}`).join('\n\n'),
    ].join('\n'),
  });
  steps.push({
    id: 'assemble',
    title: `定稿拼装（目标 ${target}）`,
    dependsOn: ['style'],
    priority: 95,
    serial: true,
    instruction: [
      `把下面各部分按顺序拼成一篇完整文稿，目标篇幅 ${target}。`,
      '要求：统一编号、删除重复段落、补写必要的过渡；正文之外不要添加说明性文字。',
      '最后在末尾单列「未完待补」清单（如果仍有缺口）。',
      '',
      '{{step:style}}',
    ].join('\n'),
  });
  return steps;
}

// novel -> chapters
function novelTemplate(args) {
  const goal = cleanGoal(args.goal);
  const chapters = Math.max(1, Math.min(40, Number(args.count) || 8));
  const genre = String(args.genre || '').trim() || '现实主义';
  const steps = [
    {
      id: 'bible',
      title: '设定圣经',
      priority: 10,
      instruction: [
        `小说主题：${goal}`,
        `类型/基调：${genre}。`,
        '产出：世界设定、主要人物小传（3-6 人）、叙事视角、时间线、核心冲突、语言风格约定（各 200 字以内）。',
        '这是全书唯一的事实来源，后续所有章节必须遵守。',
      ].join('\n'),
    },
    {
      id: 'outline',
      title: '卷纲与章纲',
      dependsOn: ['bible'],
      priority: 20,
      serial: true,
      instruction: [
        `设定：\n{{step:bible}}`,
        `请给出 ${chapters} 章的章纲：每章一句话钩子 + 3-5 个情节节点 + 结尾悬念 + 本章人物调度。`,
        '要求节奏有起伏：前 3 章建立张力，中段升级冲突，末章收束。',
      ].join('\n'),
    },
  ];
  // The first two chapters run serially (they set the voice); the rest in parallel.
  const bodyIds = [];
  for (let index = 0; index < chapters; index += 1) {
    const id = `ch${index + 1}`;
    bodyIds.push(id);
    const serial = index < 2;
    steps.push({
      id,
      title: `第 ${index + 1} 章`,
      dependsOn: index === 0 ? ['outline'] : [index === 1 ? 'ch1' : 'outline'],
      priority: serial ? 40 : 50,
      serial,
      instruction: [
        `设定：\n{{step:bible}}`,
        `章纲：\n{{step:outline}}`,
        index > 0 ? `上一章：\n{{step:ch${index}}}` : '',
        `现在写第 ${index + 1} 章正文，2600-3500 字。`,
        '要求：场景与对话推动情节，不要总结式叙述；章末留钩子；只输出正文。',
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
  }
  steps.push({
    id: 'audit',
    title: '一致性审查',
    dependsOn: bodyIds,
    priority: 80,
    serial: true,
    instruction: [
      `设定：\n{{step:bible}}`,
      '逐章检查并输出问题清单（不要重写）：人物性格/称谓/时间线/伏笔/重复桥段/节奏问题，每条给出修改建议与所在章节。',
      bodyIds.map((id) => `### ${id}\n${id === 'ch1' || id === 'ch2' ? `{{step:${id}}}` : `（见 {{step:${id}}}）`}`).join('\n\n'),
    ].join('\n'),
  });
  steps.push({
    id: 'polish',
    title: '终稿润色',
    dependsOn: ['audit', ...bodyIds],
    priority: 90,
    serial: true,
    instruction: [
      '把全书合成干净稿：按审查清单修正，统一人名与称谓，删除重复桥段，润色语言（去 AI 腔，保留作者个人笔调）。',
      '输出完整正文，不要输出修改说明。',
      '',
      '审查清单：\n{{step:audit}}',
    ].join('\n'),
  });
  return steps;
}

// drama -> episodes
function dramaTemplate(args) {
  const goal = cleanGoal(args.goal);
  const episodes = Math.max(1, Math.min(40, Number(args.count) || 6));
  const steps = [
    {
      id: 'outline',
      title: '剧集大纲与人物',
      priority: 10,
      instruction: [
        `题材：${goal}`,
        `产出：故事主线（起承转合）、3-5 个主要人物（欲望/阻碍/秘密）、全剧 5 个关键反转、结尾落点。`,
        '一句话能说清整部剧的核心冲突。',
      ].join('\n'),
    },
    {
      id: 'beats',
      title: `分集钩子表（${episodes} 集）`,
      dependsOn: ['outline'],
      priority: 20,
      serial: true,
      instruction: [
        `大纲：\n{{step:outline}}`,
        `请给出 ${episodes} 集的分集表：每集一句钩子 + 开场 30 秒抓点 + 结尾反转 + 人物关系推进。`,
      ].join('\n'),
    },
  ];
  const bodyIds = [];
  for (let index = 0; index < episodes; index += 1) {
    const id = `ep${index + 1}`;
    bodyIds.push(id);
    steps.push({
      id,
      title: `第 ${index + 1} 集剧本`,
      dependsOn: ['beats'],
      priority: 50,
      instruction: [
        `大纲：\n{{step:outline}}`,
        `分集表：\n{{step:beats}}`,
        `写第 ${index + 1} 集完整剧本（约 3-5 分钟成片体量）：分场次、场景、人物动作、对白。`,
        '要求：对白口语化、冲突前置；不要旁白解释人物心理；只输出本集剧本。',
      ].join('\n\n'),
    });
  }
  steps.push({
    id: 'audit',
    title: '连贯性与合规审查',
    dependsOn: bodyIds,
    priority: 80,
    serial: true,
    instruction: [
      '逐集检查：人物动机是否一致、时间线是否成立、是否踩合规红线（暴力/违法细节/敏感表述）。',
      '输出问题清单与修改建议，不要重写。',
      bodyIds.map((id) => `### ${id}\n{{step:${id}}}`).join('\n\n'),
    ].join('\n'),
  });
  return steps;
}

// code -> modules
function codeTemplate(args) {
  const goal = cleanGoal(args.goal);
  const modules = asList(args.modules, repeated('模块', args.count || 4, 4));
  const stack = String(args.stack || '').trim();
  const steps = [
    {
      id: 'spec',
      title: '需求规格与文件所有权',
      priority: 10,
      instruction: [
        `目标：${goal}`,
        stack ? `技术栈：${stack}。` : '',
        `请给出：功能清单、接口/数据模型、目录结构，并把代码拆成 ${modules.length} 个互不重叠的文件组（明确每个文件的唯一所有者，避免并行冲突）。`,
        '只输出规格，不写实现。',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
  const bodyIds = [];
  modules.forEach((module, index) => {
    const id = `m${index + 1}`;
    bodyIds.push(id);
    steps.push({
      id,
      title: module,
      dependsOn: ['spec'],
      priority: 50,
      caps: ['code'],
      instruction: [
        `规格：\n{{step:spec}}`,
        `只实现「${module}」这一部分，严格按规格里的文件所有权，不要修改其它模块的文件。`,
        '输出：完整文件内容（每个文件一段代码块，标注路径）+ 自测说明。',
      ].join('\n\n'),
    });
  });
  steps.push({
    id: 'integrate',
    title: '集成与测试',
    dependsOn: bodyIds,
    priority: 80,
    serial: true,
    caps: ['code'],
    instruction: [
      '把下列模块合并成可运行工程：补缺失的胶水代码、统一依赖版本、写最小测试并运行。',
      '输出：改动清单 + 实际运行结果（通过/失败）+ 剩余风险。',
      bodyIds.map((id) => `### ${id}\n{{step:${id}}}`).join('\n\n'),
    ].join('\n'),
  });
  return steps;
}

const TEMPLATES = {
  research: researchTemplate,
  novel: novelTemplate,
  drama: dramaTemplate,
  code: codeTemplate,
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

export function buildTemplate(name, args = {}) {
  const key = String(name || '').trim().toLowerCase();
  const factory = TEMPLATES[key];
  if (!factory) {
    throw new Error(`unknown template "${name}"; available: ${TEMPLATE_NAMES.join(', ')}`);
  }
  const steps = factory(args || {});
  return { template: key, steps };
}
