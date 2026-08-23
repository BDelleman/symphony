import { Liquid } from 'liquidjs';

import { WorkflowConfigError } from './errors';

export interface TemplateContext {
  issue: Record<string, unknown>;
  attempt: number | null;
  // The workflow's integration branch (workspace.provisioner.base_ref with any
  // remote prefix stripped), so prompt instructions can reference the
  // configured PR base — e.g. `gh pr create --base {{ base_ref }}` — instead
  // of leaving the agent to guess it.
  base_ref?: string;
}

export class TemplateEngine {
  private readonly engine: Liquid;

  constructor() {
    this.engine = new Liquid({
      strictFilters: true,
      strictVariables: true
    });
  }

  compile(template: string): Template {
    try {
      const parsed = this.engine.parse(template);
      return new Template(this.engine, parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'template parse failed';
      throw new WorkflowConfigError('template_parse_error', message);
    }
  }
}

export class Template {
  private readonly engine: Liquid;
  private readonly parsedTemplate: ReturnType<Liquid['parse']>;

  constructor(engine: Liquid, parsedTemplate: ReturnType<Liquid['parse']>) {
    this.engine = engine;
    this.parsedTemplate = parsedTemplate;
  }

  async render(context: TemplateContext): Promise<string> {
    try {
      return await this.engine.render(this.parsedTemplate, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'template render failed';
      throw new WorkflowConfigError('template_render_error', message);
    }
  }
}
