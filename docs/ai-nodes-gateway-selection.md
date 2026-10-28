**AI Nodes 商业化网关选型：New API 与 LiteLLM**

核验日期：2026-10-28（Asia/Shanghai）。选型对象是“可出售的自定义原子能力＋版本化 Pipeline”，首版同时交付托管 API 和企业私有化。用户已明确：核心能力可闭源，网关和适配器可开源。

**当前建议从首版选择 LiteLLM 作为统一网关；Temporal 保持执行事实源，AI Nodes Adapter 保持独立，商业订单与异步结算由独立业务模块承担。New API保留为比较对象，不规划“先New API再迁LiteLLM”的路线。** 不同时串联部署两套网关，不深度改造网关为 Workflow 引擎。

2026-10-28用户进一步明确倾向LiteLLM并重视避免未来迁移。此前推荐New API主要按首版门户与钱包复用排序，低估了长期平台一致性、已核验的New API宿主改造和迁移负担。本次改变的是选型权重，不改变下述源码事实。当前推荐不表示LiteLLM已自动提供任意Job的正确结算，仍须补齐和验收该业务链路。

**核验方法与边界**

- New API：固定已发布 tag [v1.0.0-rc.47](https://github.com/QuantumNous/new-api/releases/tag/v1.0.0-rc.47)，2026-10-25 发布。GitHub latest API 的 prerelease 为 false，但名称带 rc；插件契约也明确未正式发布，不据此称其稳定版插件生态。
- LiteLLM：固定已发布 tag [v1.106.5](https://github.com/BerriAI/litellm/releases/tag/v1.106.5)，2026-10-28 03:58（北京时间）发布。功能以 tag 源码核验，滚动文档只作补充。
- 证据为官方文档、已发布源码控制流和官方部署文件；没有部署双方实例，没有真实扣费、支付、GPU、性能或故障注入验收。源码窗口被标为“待复现风险”，不冒充已发生事故。
- 本文的商业政策、系统划分和工程工期是设计判断，不是供应商承诺。

**直接对照**

| 维度 | New API | LiteLLM | 对本项目的含义 |
|---|---|---|---|
| 产品重心 | 用户、渠道、额度、消费与任务能力经营 | 多供应商调用、兼容与企业用量治理 | 长期统一网关及用户倾向优先，主选LiteLLM |
| 自定义非标准能力 | Task Plugin 的原生路由、请求转换、查询、产物、用量钩子 | 通用 HTTP 透传，或专门视频 Provider；CustomLLM 不直接覆盖视频 | New API任务契约较直接，LiteLLM可通过独立Adapter补齐 |
| Pipeline | 作为一个版本化任务/SKU接入；DAG在Temporal | 可透传独立任务后端；不能把一个POST代理等同完整Pipeline产品 | 两者都需要薄HTTP-to-Temporal Adapter |
| 异步费用主链 | 任务预扣、价格快照、成功差额结算、失败退款已有实现 | 视频成本计算、请求预算预留、特定后台任务结算已有；任意自定义Job须另外接入 | 不应说LiteLLM完全不会异步，也不应把它当通用任务钱包 |
| 商用门户 | 用户、额度、充值/支付、Token和消费台账较多可复用 | 已有管理UI、Key、用户/团队、预算与花费；本文未找到可直接替代商业钱包全部需求的通用公开契约 | LiteLLM方案仍要补零售交易与任务商业结算 |
| 取消/恢复 | 现有Task Plugin缺少一等cancel/signal及取消终态 | 透传可以表达自定义mutation，但任务正确性由后端负责 | 两者都不能仅依赖网关的HTTP取消 |
| 授权 | 主仓AGPLv3及保留署名/链接声明；另可询商业授权 | 非enterprise部分MIT；高级企业功能单独授权 | 用户允许网关和适配器开源，New API可行；LiteLLM基础授权更宽松 |
| 私有化 | 容器/二进制，轻量SQLite；正式多节点SQL＋Redis | 简单网关可轻量；带完整管理功能使用PostgreSQL，多实例/多Worker共享限制需Redis | 不因语言/代理毫秒开销判断长期总成本 |
| 可维护性 | 插件可独立分发，但契约未冻结；宿主修正规模待PoC验证 | 透传可避免深fork；原生视频Provider和自定义结算也有升级成本 | 都要冻结宿主、插件、Adapter组合 |

New API 的宿主和插件职责及契约状态见[官方插件说明](https://docs.newapi.pro/zh/docs/plugins)。LiteLLM的[CustomLLM文档](https://docs.litellm.ai/docs/providers/custom_llm_server)列出聊天、嵌入、图片等扩展；其[视频工厂](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/videos/main.py#L200-L215)单独选择BaseVideoConfig，因此不能把聊天自定义类直接当作视频插件。

**自定义原子能力的实际接入成本**

New API：使用一个AI Nodes任务插件，把Animate、VACE、超分映射为能力/模式。通过原生路由保留驱动视频、mask、帧数等字段；插件构造HTTP请求，Adapter持有Temporal Caller证书与Codec，返回稳定任务身份。插件由宿主执行和管理，不能直接读取本机私密文件、导入Python或用gRPC代替HTTP。由版本化的请求契约校验业务参数，由插件usage schema报告计量事实；二者不是同一个Schema。

LiteLLM有两条路：
1. HTTP透传：可立即承载原生JSON及POST/GET/取消等自定义路径，适合企业已有LiteLLM时接入；SDK不会自动理解这些路径和任务状态。
2. 原生视频Provider：需要实现视频专属转换、查询、下载等，并注册到Provider配置选择链；针对标准视频任务有价值，但不适合作为所有原子能力的唯一表达。

依据：[New API插件类型](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/docs/plugin-api/v1.d.ts#L35-L99)、[插件运行约束](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/docs/plugin-api/README.md#L125-L147)、[LiteLLM视频接口契约](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/llms/base_llm/videos/transformation.py)、[透传机制](https://docs.litellm.ai/docs/proxy/pass_through)。

**一处需要纠正的许可证/功能判断**：LiteLLM滚动文档仍将透传auth标为Enterprise；但v1.106.5的[注册代码L3403–3412](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/proxy/pass_through_endpoints/pass_through_endpoints.py#L3403-L3412)已去掉付费门槛，配置auth:true接普通Key鉴权。管理员设置透传路由授权的[管理检查](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/proxy/management_endpoints/common_utils.py#L159-L235)也没有在这些检查中强制企业授权。因此不能将基本透传鉴权计为必付费用；SSO/JWT等其他企业功能另核对。

**Pipeline接入：两者都只应看到一个解决方案任务**

例如 solution.product-video.v1 = 主体参考生成 → 人物替换 → 音轨处理 → 超分。该名称是产品SKU示意，不是现有功能。

网关负责客户身份、可售SKU、渠道选择、额度与调用记录；Adapter负责把一次产品请求映射到一个Temporal Workflow，维护request_id/workflow_id/run_id与归属；Temporal负责阶段编排、子任务重试、缓存、取消和产物。用户无需为每个内部节点再次提交任务。

New API可以将Pipeline作为单个Task Plugin模型，复用提交/查询/多产物/usage主链；LiteLLM也可以透传同一任务，但还需明确谁负责产品订单、价格快照、冻结余额和终态费用。

两者均不会自动提供：解决方案质量标准、素材角色、产品版本兼容、人工审核、阶段计价、跨实例持久产物和客户数据迁移。不要把模型列表当作完整的解决方案商店，也不要把网关的fallback当作Workflow重试。

在实际运行中至少保存：
- 身份：tenant/project、用户、请求幂等键、产品/能力版本；
- 执行：Workflow/run_id、参数摘要、部署profile和产物位置；
- 商业：价格与政策版本、预扣引用、结算版本与证据；
- 状态：accepted/unknown、实际执行阶段、终态、取消确认及对账状态。

这些是建议的产品记录，不能仅依赖可变URL或浏览器设置。任务查询和mutation都验证归属，不能把客户端自行填写的tenant header当作可信身份。

**异步计费：New API的复用价值与必须修正的边界**

已存在的主链是：从用量表达式估算 → 提交前预扣 → 固化计价快照 → 后台查询 → 成功时按实际用量差额补扣/退款。插件只报告事实，宿主决定价格。来源：[预扣](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/relay/relay_task.go#L262-L352)、[任务保存与消费](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/controller/relay.go#L652-L740)、[终态结算](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/service/task_polling.go#L639-L725)。

但需要处理四项：
1. **提交与落库窗口**：上游submit先发生，随后检查客户端断连并插入网关Task。未durable时退款。断连或DB失败可能留下“Temporal在跑、网关无可恢复记录/已退款”的窗口；这是静态控制流风险，须做故障注入。需在上游副作用之前保存可恢复意图，贯穿网关和Adapter的稳定幂等键，并对账。只让GPU不重跑不能阻止两个网关订单重复预扣。[控制流L518–524](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/controller/relay.go#L518-L524)、[提交L583–587](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/controller/relay.go#L583-L587)、[落库L718–733](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/controller/relay.go#L718-L733)。
2. **失联不等于失败**：默认20次连续轮询故障或72小时超时可走失败退款；这不是Temporal已停止的证据。配置可关闭阈值，但仍要任务对账及失联告警，不应简单无限挂起。[默认值](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/common/init.go#L205-L217)、[轮询判定](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/service/task_polling.go#L729-L842)。同tag部分说明写24小时，与发布源码不一致。
3. **取消/Signal缺口**：通用Task API只有提交、查询与产物；intent只有submit/query，没有一等取消终态。原生dynamic路由不能自然补齐原任务取消和结算。建议增加小范围host扩展，或经独立可信认证的Adapter mutation路径；不能靠GET执行取消，也不应伪装为新付费任务。[通用路由](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/router/task-router.go#L14-L37)、[TaskIntent](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/docs/plugin-api/v1.d.ts#L35-L40)。
4. **部分失败收费缺口**：标准插件表达式在FAILURE上不做实际用量结算，而由调用方全退。若Pipeline最后一步失败、前面已耗GPU，本方案采用的插件表达式路径不能直接按已完成阶段收费。旧式Adaptor调整或Token重算另有路径，这不等于通用插件已经支持部分Pipeline费用。不要伪报SUCCESS只为收费。[失败分支L687–724](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/service/task_polling.go#L687-L724)。

建议首版采用“明确交付成功收费，系统失败全退”的产品政策，并预先定义主动取消、输入无效和部分可交付结果的费用。运行成本和客户售价分账：平台失败时GPU实际成本仍存在，由平台承担。若首版必须对失败或取消按阶段收费，需正式扩展宿主结算，不能仍按纯插件零修改估算。退款/结算需要可重放对账；终态CAS不等于所有资金侧效果天然exactly-once。

**LiteLLM的异步能力：已有机制，但不能直接外推到任意Job**

已核验：
- 原生视频创建路径可以按response usage中的duration/resolution/provider cost计算；缺失duration时该分支默认时长0。视频status不在该视频成本call-type集合里，因此不能假定后续GET会自动补齐每个自定义任务的最终成本。[成本分支L165–174](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/cost_calculator.py#L165-L174)、[视频计价L1697–1749](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/cost_calculator.py#L1697-L1749)。
- 已有请求预算reservation和取消调账代码，不应写成“完全没有预留”。该机制是请求预算控制；估价和reservation生命期是否覆盖独立长任务须逐路径核验。[budget reservation](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/proxy/spend_tracking/budget_reservation.py#L118-L155)。
- background interactions已有可持久化pending settlement及启动恢复；TinyFish有专门后台计费；fal透传有提交时估价。说明能力存在，但实现按协议/供应商专用，未发现声明一个任意Job Schema即可获得同等结算的通用契约。[持久化后台结算](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/proxy/spend_tracking/background_interaction_settlement.py#L181-L205)、[TinyFish](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/proxy/pass_through_endpoints/llm_provider_handlers/tinyfish_passthrough_logging_handler.py#L134-L201)、[fal透传](https://github.com/BerriAI/litellm/blob/v1.106.5/litellm/proxy/pass_through_endpoints/llm_provider_handlers/fal_ai_passthrough_logging_handler.py#L30-L56)。
- 通用透传支持单次响应header上报总成本。它不等于完整任务结算：202时还无最终费用，重复GET若每次上报累计成本也不是天然幂等。要自己接入业务Job/订单及一次性settlement，再把记录同步到网关；不要让日志回调直接充当客户余额账本。[官方费用header契约](https://docs.litellm.ai/docs/proxy/pass_through_cost_tracking)。

因此LiteLLM方案需要明确补齐“耐久异步商业结算＋零售钱包/门户”。这些是本项目市场化所需的业务建设量，应和New API已知的宿主修正、升级维护及未来迁移成本一起比较。没有必要为复用后台interaction而把视频或Pipeline伪装成某个聊天协议。

**两套方案的收费与事实源**

| 内容 | New API方案 | LiteLLM方案 |
|---|---|---|
| 执行事实源 | Temporal＋Adapter持久请求记录 | 相同 |
| 原始用量 | Adapter签发、可核验的完成事件 | 相同 |
| 客户预扣/实扣 | 尽量复用New API钱包；补幂等和可重试结算 | 自建或外接业务结算模块，再接网关记录 |
| GPU/外部供应商实际成本 | 单独成本台账，失败亦记录 | 相同 |
| 请求/状态查询日志 | 不重复作为新计费任务 | 相同 |
| 补偿 | 通过稳定结算ID对账补扣/退款 | 相同 |

不并行维护两个客户钱包。New API的额度与最终收款记录也要与支付到账核对；Stripe等代码存在不代表商户开通、拒付与退款已经验收。

**托管与私有化的总成本**

共享执行成本不因网关变化而消失：Temporal、对象存储、模型权重、GPU、CPU预处理、网络、缓存清理、备份和成片质量验收，均要在两种部署中支持。秒级/分钟级GPU任务里，网关几毫秒延迟通常不是当前选型主导指标。

| 成本项 | New API | LiteLLM |
|---|---|---|
| 现有商用门户复用 | 用户、Token、额度、充值、消费管理复用较多 | 管理UI、用户/团队、Key、预算与花费可复用，商用订单/钱包需补 |
| 能力和Pipeline业务后端 | 两者都需要 | 两者都需要 |
| 任务商业结算 | 补已知边界与部分政策 | 新接任意Job的耐久结算，工作量通常更大 |
| 网关许可证基础 | AGPL方案下无软件采购价，但履行源码/署名等义务 | MIT部分无软件采购价，但不包含全部企业特性 |
| 企业高级特性 | 按实际需求核验OIDC/隔离/审计，不能只看功能名 | SSO/SCIM、JWT、审计等部分功能在Enterprise；报价未知 |
| 私有实例复制 | 固定宿主/插件/Adapter版本，复用安装包 | 固定镜像/config/adapter；Enterprise客户部署授权需谈明 |
| 升级 | 插件契约未冻结，测试矩阵是主要成本 | Provider、hooks和费用行为也需回归；不得自动追latest |
| 离线交付 | 预装插件/镜像/模型，测试断网；不依赖在线市场 | 预装镜像/价格目录/模型，按需禁用联网与明确离线授权 |

New API正式多节点需要共享数据库、Redis和secret；SQLite只适合轻量评估/单实例范围，不把它作为默认SaaS财务高可用方案。[官方Compose](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/docker-compose.yml)。LiteLLM的[quickstart](https://github.com/BerriAI/litellm/blob/v1.106.5/docker/docker-compose.quickstart.yml)使用PostgreSQL，[生产文档](https://docs.litellm.ai/docs/proxy/deploy)和[迁移指南](https://docs.litellm.ai/docs/enterprise/moving_from_oss)说明多实例/Worker需要共享Redis。两种网关可按独立schema/用户共用同类SQL和Redis基础设施；是否共实例取决于隔离/恢复需求，不为“一个产品名”强制增加一个物理数据库。

许可证边界：
- New API是AGPLv3；README另要求修改版UI保留作者声明和原项目链接，并提供商业授权咨询。这不等于不能商用；用户接受开源网关及适配器，能采用履约开源方案。独立HTTP核心是否属于独立作品仍须按实际链接/打包/交付核对，不仅凭“拆容器”下结论。[固定版本README](https://github.com/QuantumNous/new-api/blob/v1.0.0-rc.47/README.en.md#L324-L340)。
- LiteLLM根LICENSE将非enterprise部分设为MIT。Enterprise功能不是因此自动获得OEM/再分发权。官方[价格页](https://www.litellm.ai/pricing)仅给按年度请求容量、部署和支持报价，未公布本项目金额；[激活文档](https://docs.litellm.ai/docs/enterprise/activate#verify-the-license)只说明同库跨区域授权，不可自行外推为覆盖所有独立客户实例。
- 本文不假设必须购买任一商业授权，不假设采购费为0，也不把网关授权等同模型权重的商用许可。

**预算工作分解：此前相对工期不再作为当前决策依据**

用于决定优先级的假设：3项现有原子能力＋1条固定Pipeline；一个支付通道；托管一个区域；私有化先交付容器组合；基础用户/Key；核心已有；不含通用可视化DAG编辑器、税务发票、多币种、全面企业SSO及GPU模型性能优化。人周按有效工程投入计，可并行，不能直接当日历承诺。

此前给出的New API 7–11人周、LiteLLM 10–16人周仅是同范围的粗略工作分解，未实测，没有计入团队适配、网关迁移和多客户升级负担。撤回据此得出的“本项目New API总成本更低”推论；不把历史范围当成当前承诺，也不凭偏好重编一组更有利的数字。

当前应分别估算：共同的能力契约/Adapter/产物/SDK/双部署；LiteLLM的配置与身份接入；独立订单/预扣/结算/退款；支付及客户门户；故障恢复与私有化升级。新API方案还要另计提交持久化、取消、失联和收费语义的宿主适配。若以后迁移网关，还会涉及Key与权限、在途任务ID、价格快照、余额/退款、客户端和客户安装包，不能只按换base_url估价。

首版只建设已售能力需要的订单和结算，不建设通用计费平台或可视化DAG产品；可复用支付及账单组件。授权采购、基础设施、维护和失败GPU成本单独核算，不编造供应商报价。

**推荐架构与交付边界**

托管版：LiteLLM作为默认入口，复用其鉴权、路由、限流和调用观察能力；自定义原子能力和Pipeline先通过原生HTTP透传接入独立Adapter。标准图像/视频的原生Provider适配按实际消费者需求增加，不把全部能力塞进聊天或视频协议。独立商业模块保存订单、价格快照、预扣、结算与退款；支付到账和执行用量分别核对。

私有化版：交付相同能力契约、LiteLLM配置/扩展、Adapter和执行包，连接客户自己的Temporal/存储/GPU或一并部署。也允许接入客户已有网关。私有化是否展示充值、是否实际扣款由部署策略配置，不分叉执行代码。

商业模块负责唯一的客户资金账本；Adapter提供可信用量和可重放对账，Temporal负责真实执行终态。LiteLLM的spend/budget和客户账户余额不能被不加设计地当成两个独立钱包。取消、上传URL刷新和任务归属须打通，不能把网关前台的“停止等待”当作GPU已停止。

为了避免深fork，优先配置、独立HTTP接口和公开扩展点；业务模型、Pipeline和客户账本不写进LiteLLM核心。需要原生Provider时实现可上游化的适配和测试。跨进程的任务与资金幂等是明确建设项，不声称只透传就已解决。

**生产准入与复评条件**

至少验证：
1. 相同tenant＋Idempotency-Key并发提交、网关内部重试、客户端重发，均只产生一个业务订单、一次预扣、一次Workflow。
2. Temporal已接受但网关返回前断连/重启/DB不可用：能重新关联；不会孤儿推理、丢任务或静默退款。
3. 状态查询连续20次失败和长任务超过配置时限：仍运行的Workflow不能被误当确定失败；有有界对账和人工处置。
4. 成功、取消、部分失败、退款和重复回调符合事先定义的收费政策；资金写入中杀进程后能恢复且不重复。
5. 用户A不能读取/取消B的任务；对账事件只能由可信后端产生。
6. 网关或Adapter升级时，历史在途任务仍可解析；一个私有实例能断网安装、备份和恢复。
7. 完成但上传链接过期：刷新目标只重传，不新增推理或重新收费。

当前主选LiteLLM：用户明确倾向长期统一该平台、避免未来迁移；自定义任务通过独立Adapter和业务模块补齐。不会仅因暂缺现成充值页面而引入New API作为过渡主平台。仍需验证所需企业特性授权与任意Job的结算，不承诺永久不会迁移。

只有业务明确变成以现成用户钱包/充值门户为中心，且证明采用New API的完整生命周期成本更低时再复评；不预设未来一定改选，也不并行维护两套主网关。

本轮只给出选择建议与实施门槛，没有授权或完成网关安装、支付接入、GPU调用、生产部署或相关PoC。

