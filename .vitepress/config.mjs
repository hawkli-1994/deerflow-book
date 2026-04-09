import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'DeerFlow 二次开发',
  description: '面向硬核开发者的技术深度解析',
  lang: 'zh-CN',
  
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }]
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: '首页', link: '/' },
      { text: '开始阅读', link: '/chapters/01-introduction' },
      { text: 'GitHub', link: 'https://github.com/hawkli-1994/deerflow-book' }
    ],

    sidebar: [
      {
        text: '书籍介绍',
        items: [
          { text: 'README', link: '/' }
        ]
      },
      {
        text: '第一部分：理论基础',
        items: [
          { text: '第一章 · 引言', link: '/chapters/01-introduction' },
          { text: '第二章 · 核心概念', link: '/chapters/02-core-concepts' },
          { text: '第三章 · 架构总览', link: '/chapters/03-architecture' }
        ]
      },
      {
        text: '第二部分：源码剖析',
        items: [
          { text: '第四章 · 项目结构', link: '/chapters/04-project-structure' },
          { text: '第五章 · Agent 核心', link: '/chapters/05-agent-core' },
          { text: '第六章 · Skills 与 Tools', link: '/chapters/06-skills-tools' },
          { text: '第七章 · Sub-Agent 体系', link: '/chapters/07-sub-agents' },
          { text: '第八章 · Sandbox 环境', link: '/chapters/08-sandbox' },
          { text: '第九章 · Memory 系统', link: '/chapters/09-memory' },
          { text: '第十章 · Context Engineering', link: '/chapters/10-context-engineering' }
        ]
      },
      {
        text: '第三部分：二次开发实战',
        items: [
          { text: '第十一章 · MCP Server 集成', link: '/chapters/11-mcp-server' },
          { text: '第十二章 · 自定义 Skill 开发', link: '/chapters/12-custom-skill' },
          { text: '第十三章 · Human-in-the-Loop', link: '/chapters/13-human-in-the-loop' },
          { text: '第十四章 · 企业级应用案例', link: '/chapters/14-enterprise-cases' }
        ]
      },
      {
        text: '附录',
        items: [
          { text: '附录 A · 配置参考', link: '/chapters/appendix-a-config' },
          { text: '附录 B · 贡献指南', link: '/chapters/appendix-b-contributing' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/hawkli-1994/deerflow-book' }
    ],

    editLink: {
      pattern: 'https://github.com/hawkli-1994/deerflow-book/edit/main/:path',
      text: '在 GitHub 上编辑此页'
    },

    docFooter: {
      prev: '上一页',
      next: '下一页'
    },

    outline: {
      label: '目录'
    },

    lastUpdated: {
      text: '最后更新于',
      formatOptions: {
        dateStyle: 'short',
        timeStyle: 'medium'
      }
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    }
  },

  // 构建配置
  srcDir: '.',
  outDir: '.vitepress/dist',
  base: '/deerflow-book/',
  
  // Markdown 配置
  markdown: {
    lineNumbers: true,
    config: (md) => {
      // 可以在这里添加自定义 markdown 插件
    }
  },

  // 忽略死链接检查（避免某些外部或相对链接导致构建失败）
  ignoreDeadLinks: true
})
