const express = require('express');
const { nanoid } = require('nanoid');
const { actionDelimiter, SystemRoles, removeNullishValues } = require('librechat-data-provider');
const { encryptMetadata, domainParser } = require('~/server/services/ActionService');
const { updateAction, getActions, deleteAction, getAction } = require('~/models/Action');
const { isActionDomainAllowed } = require('~/server/services/domains');
const { getAgent, updateAgent, getAgents } = require('~/models/Agent');
const { logger } = require('~/config');

const router = express.Router();

// If the user has ADMIN role
// then action edition is possible even if not owner of the assistant
const isAdmin = (req) => {
  return req.user.role === SystemRoles.ADMIN;
};

/**
 * Retrieves all user's actions
 * @route GET /actions/
 * @param {string} req.params.id - Assistant identifier.
 * @returns {Action[]} 200 - success response - application/json
 */
router.get('/', async (req, res) => {
  try {
    //JS: get all actions
    res.json(await getActions());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Add an action
 * @route POST /actions
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {FunctionTool[]} req.body.functions - The functions to be added or updated.
 * @param {ActionMetadata} req.body.metadata - Metadata for the action.
 * @returns {Object} 200 - success response - application/json
 */
router.post('/', async (req, res) => {
  try {
    const { agent_id } = req.params;

    /** @type {{ functions: FunctionTool[], metadata: ActionMetadata }} */
    const { functions, metadata: _metadata } = req.body;
    if (!functions.length) {
      return res.status(400).json({ message: 'No functions provided' });
    }

    const functionNames = functions.map((tool) => tool.function.name);

    let metadata = await encryptMetadata(removeNullishValues(_metadata, true));
    const isDomainAllowed = await isActionDomainAllowed(metadata.domain);
    if (!isDomainAllowed) {
      return res.status(400).json({ message: 'Domain not allowed' });
    }

    let { domain } = metadata;
    domain = await domainParser(req, domain, true);

    if (!domain) {
      return res.status(400).json({ message: 'No domain provided' });
    }

    const action_id = nanoid();

    // Only update user field for new actions
    const actionUpdateData = { metadata, agent_id, user: req.user.id, functions: functionNames };

    /** @type {[Action]} */
    const updatedAction = await updateAction({ action_id }, actionUpdateData);

    const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'];
    for (let field of sensitiveFields) {
      if (updatedAction.metadata[field]) {
        delete updatedAction.metadata[field];
      }
    }
    res.json(updatedAction);
  } catch (error) {
    const message = 'Trouble updating the Agent Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

/**
 * Deletes an action.
 * @route DELETE /:action_id
 * @param {string} req.params.action_id - The ID of the action to delete.
 * @returns {Object} 200 - success response - application/json
 */
router.delete('/:action_id', async (req, res) => {
  try {
    const { action_id } = req.params;

    const deletedAction = await deleteAction({ action_id });
    let domain = deletedAction.metadata.domain;
    domain = await domainParser(req, domain, true);

    // Find all agents that contain this action_id in their actions field
    const agents = await getAgents({
      actions: { $elemMatch: { $regex: action_id, $options: 'i' } },
    });

    for (const agent of agents) {
      const { id: agentId, actions = [], tools = [] } = agent;

      const updatedActions = actions.filter((action) => !action.includes(action_id));
      const updatedTools = tools.filter(
        (tool) => !(tool && (tool.includes(action_id) || tool.includes(domain))),
      );

      await updateAgent({ id: agentId }, { actions: updatedActions, tools: updatedTools });
    }

    res.status(200).json({ message: 'Action deleted successfully' });
  } catch (error) {
    const message = 'Trouble deleting the Agent Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

/**
 * Updates an action.
 * @route PUT /:action_id
 * @param {string} req.params.action_id - The ID of the action to update.
 * @return {Object} 200 - success response - application/json
 */
router.put('/:action_id', async (req, res) => {
  try {
    const { action_id } = req.params;

    const action = await getAction({ action_id });

    if (!action) {
      return res.status(404).json({ message: 'Action not found' });
    }

    const oldDomain = action.metadata.domain;

    const { functions, metadata: _metadata } = req.body;
    if (!functions.length) {
      return res.status(400).json({ message: 'No functions provided' });
    }

    let metadata = await encryptMetadata(removeNullishValues(_metadata, true));
    const isDomainAllowed = await isActionDomainAllowed(metadata.domain);
    if (!isDomainAllowed) {
      return res.status(400).json({ message: 'Domain not allowed' });
    }

    let { domain } = metadata;
    domain = await domainParser(req, domain, true);

    if (!domain) {
      return res.status(400).json({ message: 'No domain provided' });
    }

    const actionUpdateData = {
      metadata,
      user: req.user.id,
      functions: functions.map((tool) => tool.function.name),
    };

    /** @type {[Action]} */
    const updatedAction = await updateAction({ action_id }, actionUpdateData);

    // Find all agents that contain this action_id in their actions field
    const agents = await getAgents({
      actions: { $elemMatch: { $regex: action_id, $options: 'i' } },
    });

    // Update each agent's actions and tools if needed
    for (const agent of agents) {
      const { id: agentId, actions = [], tools = [] } = agent;

      const updatedActions = [
        ...actions.filter((action) => !action.includes(action_id)),
        `${domain}${actionDelimiter}${action_id}`,
      ];

      // remove the tool use old domain
      const updatedTools = tools
        .filter((tool) => !(tool && (tool.includes(oldDomain) || tool.includes(action_id))))
        .concat(functions.map((tool) => `${tool.function.name}${actionDelimiter}${domain}`));

      await updateAgent(
        { id: agentId },
        {
          actions: updatedActions,
          tools: updatedTools,
        },
      );
    }

    const sensitiveFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'];
    for (let field of sensitiveFields) {
      if (updatedAction.metadata[field]) {
        delete updatedAction.metadata[field];
      }
    }
    res.json(updatedAction);
  } catch (error) {
    const message = 'Trouble updating the Agent Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

/**
 * Add an action for a specific agent
 * @route GET /actions/:agent_id/:action_id
 * @param {string} req.params.agent_id - Agent identifier.
 * @param {string} req.params.action_id - Action identifier.
 * @returns {Action} 200 - success response - application/json
 */
router.post('/:agent_id/:action_id', async (req, res) => {
  try {
    const { agent_id, action_id } = req.params;
    const admin = isAdmin(req);

    // If admin, can edit any agent, otherwise only user's agents
    const agentQuery = admin ? { id: agent_id } : { id: agent_id, author: req.user.id };
    const agent = await getAgent(agentQuery);
    if (!agent) {
      return res.status(404).json({ message: 'Agent not found for adding action' });
    }

    const action = await getAction({ action_id });

    if (!action) {
      return res.status(404).json({ message: 'Action not found for adding to agent' });
    }

    let {
      metadata: { domain },
      functions,
    } = action;

    domain = await domainParser(req, domain, true);

    const { actions: agentActions = [] } = agent;

    // Add it if not exists yet
    if (!agentActions.find((a) => a.includes(action_id))) {
      agentActions.push(`${domain}${actionDelimiter}${action_id}`);

      /** @type {string[]}} */
      const { tools: _tools = [] } = agent;

      const tools = _tools
        .filter((tool) => !(tool && (tool.includes(domain) || tool.includes(action_id))))
        .concat(functions.map((f) => `${f}${actionDelimiter}${domain}`));
      await updateAgent(agentQuery, { actions: agentActions, tools: tools });
    }

    res.status(200).json({ message: 'Action added successfully' });
  } catch (error) {
    const message = 'Trouble adding the Agent Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

/**
 * Deletes an action for a specific agent.
 * @route DELETE /actions/:agent_id/:action_id
 * @param {string} req.params.agent_id - The ID of the agent.
 * @param {string} req.params.action_id - The ID of the action to delete.
 * @returns {Object} 200 - success response - application/json
 */
router.delete('/:agent_id/:action_id', async (req, res) => {
  try {
    const { agent_id, action_id } = req.params;
    const admin = isAdmin(req);

    // If admin, can delete any agent, otherwise only user's agents
    const agentQuery = admin ? { id: agent_id } : { id: agent_id, author: req.user.id };
    const agent = await getAgent(agentQuery);
    if (!agent) {
      return res.status(404).json({ message: 'Agent not found for deleting action' });
    }

    const { tools = [], actions = [] } = agent;

    let domain = '';
    const updatedActions = actions.filter((action) => {
      if (action.includes(action_id)) {
        [domain] = action.split(actionDelimiter);
        return false;
      }
      return true;
    });

    if (!domain) {
      return res.status(400).json({ message: 'No domain provided' });
    }

    const updatedTools = tools.filter((tool) => !(tool && tool.includes(domain)));

    await updateAgent(agentQuery, { tools: updatedTools, actions: updatedActions });

    res.status(200).json({ message: 'Action deleted for agent successfully' });
  } catch (error) {
    const message = 'Trouble deleting the Agent Action';
    logger.error(message, error);
    res.status(500).json({ message });
  }
});

module.exports = router;
