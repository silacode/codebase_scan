/**
 * CWE → impact class for rules-based classification; first match in cweIds wins.
 * Buckets are product-defined (see impactCriteria in context-classifier.ts); assignments
 * follow MITRE's CWE definitions: https://cwe.mitre.org/data/definitions/<id>.html
 */
export const cweImpactMap: Record<string, string> = {
  // Code/command injection and deserialization run attacker code in the process.
  '94': 'code_execution', // Improper Control of Generation of Code
  '77': 'code_execution', // Command Injection
  '78': 'code_execution', // OS Command Injection
  '502': 'code_execution', // Deserialization of Untrusted Data
  '1321': 'prototype_pollution', // Prototype Pollution
  // Resource exhaustion degrades or kills availability.
  '400': 'denial_of_service', // Uncontrolled Resource Consumption
  '1333': 'denial_of_service', // Inefficient Regular Expression Complexity
  '770': 'denial_of_service', // Allocation of Resources Without Limits
  '674': 'denial_of_service', // Uncontrolled Recursion
  '79': 'xss', // Cross-site Scripting
  '22': 'path_traversal', // Path Traversal
  '918': 'ssrf', // Server-Side Request Forgery
  '601': 'open_redirect', // Open Redirect
  '89': 'injection', // SQL Injection
  // Broken authentication/authorization lets attackers act as someone else.
  '287': 'auth_bypass', // Improper Authentication
  '285': 'auth_bypass', // Improper Authorization
  '863': 'auth_bypass', // Incorrect Authorization
  '200': 'information_exposure', // Information Exposure
  '201': 'information_exposure', // Insertion of Sensitive Information Into Sent Data
};
