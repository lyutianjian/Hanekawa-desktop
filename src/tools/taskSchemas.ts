import { z } from 'zod/v3'

export const taskUpdateStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'deleted'])

const newTaskSchema = z.object({
  subject: z.string().min(1).describe('A brief title for the task'),
  description: z.string().min(1).describe('What needs to be done'),
  activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Arbitrary metadata to attach to the task'),
}).strict()

export const taskCreateInputSchema = z.object({
  tasks: z.array(newTaskSchema).min(1).describe('The tasks to create, in order'),
}).strict()

export const taskGetInputSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to retrieve'),
}).strict()

export const taskUpdateInputSchema = z.object({
  taskId: z.string().min(1).describe('The ID of the task to update'),
  subject: z.string().min(1).optional().describe('New subject for the task'),
  description: z.string().min(1).optional().describe('New description for the task'),
  activeForm: z.string().min(1).optional().describe('Present continuous form shown when in_progress'),
  status: taskUpdateStatusSchema.optional().describe('New status for the task'),
  owner: z.string().optional().describe('New owner for the task'),
  addBlocks: z.array(z.string()).optional().describe('Task IDs that this task blocks'),
  addBlockedBy: z.array(z.string()).optional().describe('Task IDs that block this task'),
  metadata: z.record(z.string(), z.unknown()).optional().describe('Metadata keys to merge into the task. Set a key to null to delete it.'),
}).strict()

export type TaskCreateInput = z.infer<typeof taskCreateInputSchema>
export type NewTaskInput = z.infer<typeof newTaskSchema>
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>
