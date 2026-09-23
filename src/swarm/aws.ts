import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BEE_LABEL, RUN_LABEL } from './docker.js'
import { CLUSTER } from './ecs.js'
import type { RunPlan } from './plan.js'

/**
 * The same run on real AWS as commands for a person to run, one per block, each saying what it creates or destroys.
 * Nothing here calls AWS, and ACCOUNT, REGION, SUBNET and SECURITY_GROUP are left for that person to fill in.
 */

const fence = (why: string, command: string): string => `# ${why}\n\`\`\`bash\n${command}\n\`\`\`\n`

export const awsHandover = (plan: RunPlan, directory: string): string => {
	mkdirSync(directory, { recursive: true })
	writeFileSync(join(directory, 'plan.json'), `${JSON.stringify(plan, null, '\t')}\n`)
	const registry = 'ACCOUNT.dkr.ecr.REGION.amazonaws.com'
	const blocks: string[] = [
		`Run ${plan.run} against ${plan.url} on AWS Fargate, as ${plan.bees.length} task(s).\n` +
			'Replace ACCOUNT, REGION, SUBNET and SECURITY_GROUP first. Nothing here has been run.\n',
		fence(
			'Creates nothing; logs Docker in to your ECR registry for the pushes below.',
			`aws ecr get-login-password --region REGION | docker login --username AWS --password-stdin ${registry}`,
		),
	]
	for (const kind of ['browser', 'protocol'] as const) {
		const image = plan.bees.find(bee => bee.kind === kind)?.image
		if (image === undefined) continue
		blocks.push(
			fence(
				`Creates the ECR repository drexbot-bee-${kind}. Destroy it with: aws ecr delete-repository --repository-name drexbot-bee-${kind} --force`,
				`aws ecr create-repository --repository-name drexbot-bee-${kind}`,
			),
			fence(
				'Creates nothing remote; tags the local image for ECR.',
				`docker tag ${image} ${registry}/${image}`,
			),
			fence(
				`Uploads the ${kind} bee image to ECR, where storage is billed.`,
				`docker push ${registry}/${image}`,
			),
		)
	}
	blocks.push(
		fence(
			`Creates the ECS cluster ${CLUSTER}, which costs nothing while empty. Destroy it with: aws ecs delete-cluster --cluster ${CLUSTER}`,
			`aws ecs create-cluster --cluster-name ${CLUSTER}`,
		),
	)
	for (const bee of plan.bees) {
		const file = join(directory, `${bee.id}.task-definition.json`)
		writeFileSync(
			file,
			`${JSON.stringify(
				{
					family: `drexbot-${plan.run}-${bee.id}`,
					requiresCompatibilities: ['FARGATE'],
					networkMode: 'awsvpc',
					cpu: String(Math.max(256, Math.round(bee.cpus * 1024))),
					memory: String(Math.max(512, Math.round(bee.memory / 1024 ** 2))),
					containerDefinitions: [
						{
							name: 'bee',
							image: `${registry}/${bee.image}`,
							essential: true,
							environment: Object.entries(bee.env).map(([name, value]) => ({ name, value })),
							dockerLabels: { [RUN_LABEL]: plan.run, [BEE_LABEL]: bee.id },
							logConfiguration: {
								logDriver: 'awslogs',
								options: {
									'awslogs-group': '/drexbot/swarm',
									'awslogs-region': 'REGION',
									'awslogs-stream-prefix': plan.run,
									'awslogs-create-group': 'true',
								},
							},
						},
					],
				},
				null,
				'\t',
			)}\n`,
		)
		blocks.push(
			fence(
				`Registers ${bee.id}'s task definition, which costs nothing. Destroy it with: aws ecs deregister-task-definition --task-definition drexbot-${plan.run}-${bee.id}:1`,
				`aws ecs register-task-definition --cli-input-json file://${file}`,
			),
			fence(
				`Starts ${bee.id}: one Fargate task, billed until it stops itself at ${plan.lifetime}s.`,
				`aws ecs run-task --cluster ${CLUSTER} --launch-type FARGATE --started-by ${plan.run} ` +
					`--task-definition drexbot-${plan.run}-${bee.id} ` +
					`--network-configuration 'awsvpcConfiguration={subnets=[SUBNET],securityGroups=[SECURITY_GROUP],assignPublicIp=ENABLED}'`,
			),
		)
	}
	blocks.push(
		fence(
			`Creates nothing; after ${plan.lifetime}s, lists the run's tasks still running. Anything listed is still billing.`,
			`aws ecs list-tasks --cluster ${CLUSTER} --started-by ${plan.run} --desired-status RUNNING`,
		),
		fence(
			'Stops one task left running; replace TASK with an ARN from the list above. Destroys that task.',
			`aws ecs stop-task --cluster ${CLUSTER} --task TASK --reason 'drexbot swarm teardown'`,
		),
		fence(
			`Creates nothing; downloads the bees' lines, which \`drexbot swarm reconcile ${directory}\` turns into a run record.`,
			`aws logs filter-log-events --log-group-name /drexbot/swarm --log-stream-name-prefix ${plan.run} --query 'events[].[message]' --output text > ${join(directory, 'bee-lines.txt')}`,
		),
	)
	return blocks.join('\n')
}
