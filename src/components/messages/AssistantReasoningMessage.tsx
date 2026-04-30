import React from 'react'
import { Box, Text } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown } from '../Markdown.js'

type Props = {
  param: { type: 'reasoning'; reasoning: string }
  addMargin: boolean
  isTranscriptMode: boolean
  verbose: boolean
}

export function AssistantReasoningMessage({
  param: { reasoning },
  addMargin = false,
  isTranscriptMode,
  verbose,
}: Props): React.ReactNode {
  if (!reasoning) return null

  const shouldShowFull = isTranscriptMode || verbose

  if (!shouldShowFull) {
    return (
      <Box marginTop={addMargin ? 1 : 0}>
        <Text dimColor italic>
          ∴ Reasoning <CtrlOToExpand />
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} marginTop={addMargin ? 1 : 0} width="100%">
      <Text dimColor italic>∴ Reasoning…</Text>
      <Box paddingLeft={2}>
        <Markdown dimColor>{reasoning}</Markdown>
      </Box>
    </Box>
  )
}
