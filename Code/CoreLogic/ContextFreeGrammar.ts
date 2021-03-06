import {FiniteStateAutomata, AutomataJSON} from "./FiniteStateAutomata"
import {Lexer} from "./Lexer"
import { tokenID, TokenError, TokenEOF, TokenDefault, TokenJSON } from "./Token";
import * as Vis from 'vis';
import { stringComp, AVLMap, AVLSet, intComp, arrComp } from "../avl/avl";

export type nonTerminal = string
export type productionText = Array<any>
export interface production {
	RHS: productionText,
	callback: ((args: Array<any>)=>any) | null
}

export class node {
	LHS: nonTerminal
	rule: production
	children: Array<node>

	constructor (LHS: nonTerminal, rule: production = {RHS: [], callback: null}, children: Array<node> = []) {
		this.LHS = LHS
		this.rule = rule
		this.children = children
	}
}

export interface ParseInfo {
	lexemes: Array<string>,
	derivations: Array<node>
}

export interface ProductionJSON {
	RHS: productionText,
	callback: string | null
}

export interface CFGJSON {
	name: string
	initialSymbol: nonTerminal
	terminalSymbols: Array<tokenID>
	nonTerminalSymbols: Array<nonTerminal>
	productions: Array<[nonTerminal, Array<ProductionJSON>]>
	FSA: AutomataJSON|null
}

export interface serializedCFG {
	Tokens: Array<TokenJSON>
	Grammars: Array<CFGJSON>
}

export class item {

	LHS: nonTerminal
	rule: production
	start: number
	position: number
	lookahead: tokenID
	prev: null | item
	complete: null | item

	constructor (LHS: nonTerminal, rule: production, start: number, position: number, lookahead: tokenID) {
		this.LHS = LHS
		this.rule = rule
		this.start = start
		this.position = position
		this.lookahead = lookahead
		this.prev = null
		this.complete = null
	}

	clone(): item {
		let newItem: item = new item(this.LHS, this.rule, this.start, this.position, this.lookahead)
		newItem.prev = this.prev
		newItem.complete = this.complete
		return newItem
	}

	nextPosition(): tokenID|nonTerminal {
		if (this.position < this.rule.RHS.length)
			return this.rule.RHS[this.position]
		else
			return TokenEOF
	}

	end(): boolean {
		return this.position == this.rule.RHS.length
	}

	compareTo(other: item): number{
		if(this.LHS != other.LHS) return stringComp(this.LHS, other.LHS)
		if(this.start != other.start) return this.start - other.start
		if(this.position != other.position) return this.position - other.position
		let comp = arrComp(this.rule.RHS, other.rule.RHS)
		if(comp != 0) return comp
		return this.lookahead - other.lookahead
	}

	hash(): number{
		let x0 = 1001, mod = 1e7 + 19
		let str = this.LHS + "\0" + this.rule.RHS.join(",") + "\0" + this.start.toString() + "\0" + this.position.toString() + "\0" + this.lookahead
		let h = 0, pot = 1
		for(let i = 0; i < str.length; ++i){
			h = (h + str.charCodeAt(i) * pot % mod) % mod
			pot = pot * x0 % mod
		}
		return h
	}
}

let itemComp = function(a: item, b: item){return a.compareTo(b)}
let itemHash = function(a: item){return a.hash()}

export class CFG {
	
	terminalSymbols: AVLSet<tokenID>
	nonTerminalSymbols: AVLSet<nonTerminal>
	initialSymbol: nonTerminal
	productions: AVLMap<nonTerminal, AVLSet<production> >
	first: AVLMap<nonTerminal, AVLSet<tokenID> >
	follow: AVLMap<nonTerminal, AVLSet<tokenID> >
	LL1Table: Map<nonTerminal, Map<tokenID, production> > | null
	LRTable: Map<number, Map<tokenID | nonTerminal, item | number> > | null
	name: string
	FSA: FiniteStateAutomata|null

	constructor (terminalSymbols: Array<tokenID>, nonTerminalSymbols: Array<nonTerminal>, initialSymbol: nonTerminal, FSA: FiniteStateAutomata|null) {
		this.terminalSymbols = new AVLSet(intComp, terminalSymbols)
		this.nonTerminalSymbols = new AVLSet(stringComp, nonTerminalSymbols)
		this.first = new AVLMap(stringComp)
		this.follow = new AVLMap(stringComp)
		this.LL1Table = null
		this.LRTable = null
		this.productions = new AVLMap(stringComp)
		this.initialSymbol = initialSymbol
		this.name = ""
		this.FSA = FSA
	}

	getName(): string {
        return this.name
    }

    setName(name: string): void {
        this.name = name
    }

    private addProductionIfNotExist(LHS: nonTerminal): void {
    	if (!this.productions.has(LHS)){
			this.productions.set(LHS, new AVLSet(function(a, b){return arrComp(a.RHS, b.RHS)}))
			this.first.set(LHS, new AVLSet(intComp))
			this.follow.set(LHS, new AVLSet(intComp))
		}
    }

    isTerminal(token: tokenID|nonTerminal): boolean {
    	return (typeof token === "number") && this.terminalSymbols.has(token)
    }

    isNonTerminal(LHS: tokenID|nonTerminal): boolean {
    	return (typeof LHS === "string") && this.nonTerminalSymbols.has(LHS)
    }

    addRule(LHS: nonTerminal, RHS: productionText, callback: ((args: Array<any>)=>any) | null): boolean {
    	if (!this.isNonTerminal(LHS)) return false
    	this.addProductionIfNotExist(LHS)
    	this.productions.get(LHS)!.add({
    		RHS: RHS,
    		callback: callback
    	})
    	return true
	}

	removeLeftRecursion(depth: number = 0): CFG {
		let goodRules: AVLSet<nonTerminal> = new AVLSet(stringComp)
		let badRules: AVLSet<nonTerminal> = new AVLSet(stringComp)
		this.productions.forEach( (rules, LHS) => {
			rules.forEach(production => {
				if(production.RHS.length > 0 && production.RHS[0] === LHS)
					badRules.add(LHS)
			})
		})
		this.nonTerminalSymbols.forEach(LHS => {
			if(!badRules.has(LHS))
				goodRules.add(LHS)
		})

		let result: CFG = new CFG(this.terminalSymbols.toArray(), this.nonTerminalSymbols.toArray(), this.initialSymbol, this.FSA)
		if(depth == 0) result.setName(this.getName() + " non left-recursive")
		else result.setName(this.getName())

		badRules.forEach(LHS => {
			let productions: AVLSet<production> = this.productions.get(LHS)!
			let newLHS = LHS
			while(this.nonTerminalSymbols.has(newLHS)) newLHS += "'"
			result.nonTerminalSymbols.add(newLHS)
			productions.forEach(production => {
				let RHS: productionText = production.RHS
				if(RHS.length > 0 && RHS[0] === LHS){
					let newRHS: Array<tokenID|nonTerminal> = [...RHS]
					newRHS.splice(0, 1)
					newRHS.push(newLHS)
					let strFunc: string = 'function(args){'+
						'var strFunc = ' + (production.callback == null ? "function(){return null}" : production.callback.toString()) + ';'+
						'var list = args.pop();'+
						'list.push([args, strFunc]);'+
						'return list;'+
					'}'
					result.addRule(newLHS, newRHS, new Function("return " + strFunc)())
				}else{
					let newRHS: Array<tokenID|nonTerminal> = [...RHS]
					newRHS.push(newLHS)
					let strFunc: string = 'function(args){'+
						'var strFunc = ' + (production.callback == null ? "function(){return null}" : production.callback.toString()) + ';'+
						'var list = args.pop();'+
						'var result = new Function("return " + strFunc)()(args);'+
						'list.reverse().forEach(elem => {result = new Function("return " + elem[1])()([result, ...elem[0]])});'+
						'return result;'+
					'}'
					result.addRule(LHS, newRHS, new Function("return " + strFunc)())
				}
			})
			result.addRule(newLHS, [], function(){return []})
		})

		goodRules.forEach(LHS => {
			let productions: AVLSet<production> = this.productions.get(LHS)!
			productions.forEach(production => {
				result.addRule(LHS, [...production.RHS], production.callback)
			})
		})

		if(badRules.size() == 0) return result
		else return result.removeLeftRecursion(depth + 1)
	}

	isAugmented(): boolean {
		let S = this.initialSymbol
		let init = this.productions.get(S)!
		if(!(init.size() == 1 && init.nthElement(0)!.key!.RHS.length <= 1)) return false
		let augmented: boolean = true
		this.productions.forEach((rules, _) => {
			rules.forEach(rule => {
				rule.RHS.forEach(c => {
					if(c === S) augmented = false
				})
			})
		})
		return augmented
	}

	augment(): CFG {
		let newInitial = this.initialSymbol
		while(this.nonTerminalSymbols.has(newInitial)) newInitial += "'"
		let result: CFG = new CFG(this.terminalSymbols.toArray(), [newInitial, ...this.nonTerminalSymbols.toArray()], newInitial, this.FSA)
		result.setName(this.getName() + " augmented")
		result.addRule(newInitial, [this.initialSymbol], function(args){return args[0]})
		this.productions.forEach( (rules, LHS) => {
			rules.forEach(rule => {
				result.addRule(LHS, [...rule.RHS], rule.callback)
			})
		})
		return result
	}

	calculateFirstSets(): void {
		this.first.forEach(set => set.clear())
		let change: boolean = true
		while(change){
			change = false
			this.productions.forEach( (rules, LHS) => {
				let newSet: AVLSet<tokenID> = this.first.get(LHS)!.clone()
				rules.forEach(production => {
					let i = 0
					for(; i < production.RHS.length; ++i){
						let c = production.RHS[i]
						if(this.isTerminal(c)){
							newSet.add(c)
							break
						}
						let firstOfC: AVLSet<tokenID> = this.first.get(c)!.clone()
						firstOfC.erase(TokenDefault)
						newSet.join(firstOfC)
						if(!this.nullable(c)) break
					}

					if(i == production.RHS.length)
						newSet.add(TokenDefault)
				})

				change = change || (newSet.compareTo(this.first.get(LHS)!) != 0)
				this.first.set(LHS, newSet)
			})
		}
	}

	calculateFollowSets(): void {
		this.follow.forEach(set => set.clear())
		this.follow.get(this.initialSymbol)!.add(TokenEOF)

		this.productions.forEach( (rules, _) => {
			rules.forEach(production => {
				for(let i = 0; i < production.RHS.length; ++i){
					let c = production.RHS[i]
					if(this.isNonTerminal(c)){
						for(let j = i+1; j < production.RHS.length; ++j){
							let d = production.RHS[j]
							if(this.isTerminal(d)){
								this.follow.get(c)!.add(d)
								break
							}
							this.follow.get(c)!.join(this.first.get(d)!)
							if(!this.nullable(d)) break
						}
					}
				}
			})
		})

		let change: boolean = true
		while(change){
			change = false
			this.productions.forEach( (rules, LHS) => {
				rules.forEach(production => {
					for(let i = production.RHS.length-1; i >= 0; --i){
						let c = production.RHS[i]
						if(this.isTerminal(c)) break
						let newSet: AVLSet<tokenID> = new AVLSet(intComp, [...this.follow.get(c)!.toArray(), ...this.follow.get(LHS)!.toArray()])
						change = change || (newSet.compareTo(this.follow.get(c)!) != 0)
						this.follow.set(c, newSet)
						if(!this.nullable(c)) break
					}
				})
			})
		}

		this.follow.forEach(followSet => followSet.erase(TokenDefault))
	}

	private firstRHS(RHS: productionText): AVLSet<tokenID> {
		let result: AVLSet<tokenID> = new AVLSet(intComp)
		let i = 0
		for(; i < RHS.length; ++i){
			let c = RHS[i]
			if(c === TokenEOF || this.isTerminal(c)){
				result.add(c)
				break
			}
			let firstOfC: AVLSet<tokenID> = this.first.get(c)!.clone()
			let nullable: boolean = firstOfC.has(TokenDefault)
			firstOfC.erase(TokenDefault)
			result.join(firstOfC)
			if(!nullable) break
		}
		if(i == RHS.length)
			result.add(TokenDefault)
		return result
	}

	private nullable(LHS: nonTerminal): boolean {
		return this.first.get(LHS)!.has(TokenDefault)
	}

	// ============ Begin of recursive descent parser ============
	recursiveDescent(): string {
		let ans = ""
		this.calculateFirstSets()
		this.calculateFollowSets()
		ans += "int t;\n\n"
		ans += "bool match(int matched) {\n"
		ans += "    if (t != matched) return false;\n"
		ans += "    printf(\"Token matched: %d\\n\", matched);\n"
		ans += "    t = nextToken();\n"
		ans += "    return true;\n"
		ans += "}\n\n"
		this.productions.forEach( (_, LHS) => {
			ans += "bool " + LHS.replace("'", "p") + "();\n"
		})
		this.productions.forEach( (rules, LHS) => {
			ans += "\nbool " + LHS.replace("'", "p") + "() {\n"
			ans += "    bool valid = true;\n"
			ans += "    switch(t) {\n"
			rules.forEach(rule => {
				if(rule.RHS.length > 0){
					ans += this.firstRHS(rule.RHS).toArray().map(c => {
						if(c !== TokenDefault) return "        case " + c.toString().replace("'", "p") + ":\n"
						else return null
					}).filter(c => c != null).join("")
					ans += rule.RHS.map(c => {
						if(this.isNonTerminal(c)) return "            valid = valid && " + c.toString().replace("'", "p") + "();\n"
						else return "            valid = valid && match(" + c + ");\n"
					}).join("")
					ans += "            break;\n"
				}
			})
			if(this.nullable(LHS)){
				ans += this.follow.get(LHS)!.toArray().map(c => "        case " + c.toString().replace("'", "p") + ":\n").join("")
				ans += "            break;\n"
			}
			ans += "        default:\n"
			ans += "            valid = false;\n"
			ans += "	}\n"
			ans += "	return valid;\n"
			ans += "}\n\n"
		})
		ans += "int main() {\n"
		ans += "    t = nextToken();\n"
		ans += "    if (" + this.initialSymbol.replace("'", "p") + "())\n"
		ans += "        printf(\"Accepted.\\n\");\n"
		ans += "    else\n"
		ans += "        printf(\"Syntax error.\\n\");\n"
		ans += "    exit(0);\n"
		ans += "}\n"
		return ans
	}
	// ============ End of recursive descent parser ============

	// ============ Begin of LL(1) parser ============
	buildLL1Table(): boolean {
		let result: boolean = true
		this.calculateFirstSets()
		this.calculateFollowSets()
		this.LL1Table = new Map()

		this.productions.forEach( (rules, LHS) => {
			this.LL1Table!.set(LHS, new Map())
			let row: Map<tokenID, production> = this.LL1Table!.get(LHS)!
			rules.forEach(production => {
				let domain: AVLSet<tokenID> = this.firstRHS(production.RHS)
				if(domain.has(TokenDefault)){
					domain.join(this.follow.get(LHS)!)
					domain.erase(TokenDefault)
				}
				domain.forEach(arg => {
					if(row.has(arg))
						result = false
					row.set(arg, production)
				})
			})
		})
		if(!result) this.LL1Table = null
		return result
	}

	parseStringWithLL1(testString: string, callback: ((stackContent: productionText, position: tokenID, action: productionText)=>any) | null = null): ParseInfo|null {
		if(!this.buildLL1Table()) return null
		
		let derivation = new node(this.initialSymbol)
		let stack: Array<tokenID | node> = [TokenEOF, derivation]
		let nodes: Array<node> = []
		let valid: boolean = true

		if(this.FSA == null) return null
		let lexer: Lexer = new Lexer(this.FSA, testString)
		let prevPosition = 0
		let lexemes: Array<string> = []

		while (true) {
			let currentToken: tokenID = lexer.getNextToken()
			if (currentToken === TokenError) lexer.advance()
			if (currentToken != TokenEOF && prevPosition == lexer.position) {
                lexer.advance()
                currentToken = TokenError
			}

			if(valid){
				if(stack.length == 0) break
				let top: tokenID | node
				while(true){
					let stackContent = stack.map(c => {
						if(typeof c === "number" && (c === TokenEOF || this.isTerminal(c)))
							return c
						else if(typeof c === "object")
							return c.LHS
						else
							return ""
					})
					top = stack.pop()!
					if(typeof top === "number" && (top === TokenEOF || this.isTerminal(top))){
						if(top === currentToken){
							if(top === TokenEOF){
								nodes.push(derivation)
								if(callback && valid) callback(stackContent, currentToken, ["accepted"])
							}else{
								if(callback && valid) callback(stackContent, currentToken, ["pop"])
							}
						}else{
							if(callback && valid) callback(stackContent, currentToken, ["error"])
							valid = false
							break
						}
						break
					}else if(typeof top === "object"){
						let row = this.LL1Table!.get(top.LHS)!
						if(!row.has(currentToken)){
							if(callback && valid) callback(stackContent, currentToken, ["error"])
							valid = false
							break
						}
						top.rule = row.get(currentToken)!
						let newStack: Array<tokenID | node> = []
						let newAction: productionText = []
						top.rule.RHS.forEach(c => {
							if(this.isNonTerminal(c)){
								let newNode = new node(c);
								(top as node).children.push(newNode)
								newStack.push(newNode)
							}else{
								newStack.push(c)
							}
							newAction.push(c)
						})
						newStack.reverse().forEach(c => stack.push(c))
						if(callback && valid) callback(stackContent, currentToken, newAction)
					}
				}
			}

			if (currentToken === TokenEOF) break
			lexemes.push(testString.substring(prevPosition, lexer.position));
			prevPosition = lexer.position
		}

		return {
			lexemes: lexemes,
			derivations: nodes,
		}
	}
    // ============ End of LL(1) parser ============
    
	// ============ Begin of LR parser =============
    itemClosure(items: AVLSet<item>, useLookahead: boolean): AVLSet<item> {
        let visited: AVLSet<item> = new AVLSet(itemComp, [], itemHash)
        let self = this

        let dfs: (fromItem: item) => void = function(fromItem: item): void {
            visited.add(fromItem)
            let next = fromItem.nextPosition()
            if(typeof next === "string" && self.isNonTerminal(next)){
                self.productions.get(next)!.forEach(production => {
					if(useLookahead){
							let firstSet = self.firstRHS([...[...fromItem.rule.RHS].splice(fromItem.position + 1), fromItem.lookahead])
							firstSet.forEach(b => {
								let newItem = new item(next as nonTerminal, production, 0, 0, b)
								if(!visited.has(newItem)) dfs(newItem)
							})
					}else{
						let newItem = new item(next as nonTerminal, production, 0, 0, 0)
						if(!visited.has(newItem)) dfs(newItem)
					}
                })
            }
        }

        items.forEach(item => {
            if(!visited.has(item)) dfs(item)
        })

        return visited
    }

    itemMove(items: AVLSet<item>, symbol: tokenID|nonTerminal): AVLSet<item> {
        if(!this.isTerminal(symbol) && !this.isNonTerminal(symbol))
            return new AVLSet(itemComp, [], itemHash)

        let visited: AVLSet<item> = new AVLSet(itemComp, [], itemHash)
        items.forEach(item => {
            if(item.nextPosition() === symbol){
                let newItem = item.clone()
                newItem.position++
                visited.add(newItem)
            }
        })

        return visited
    }

    itemGo(items: AVLSet<item>, symbol: tokenID|nonTerminal, useLookahead: boolean): AVLSet<item> {
        if(!this.isTerminal(symbol) && !this.isNonTerminal(symbol))
            return new AVLSet(itemComp, [], itemHash)

        return this.itemClosure(this.itemMove(items, symbol), useLookahead)
	}
	
	getCoreItems(items: AVLSet<item>): AVLSet<item> {
		let result: AVLSet<item> = new AVLSet(itemComp, [], itemHash)
		items.forEach(item => {
			let newItem = item.clone()
			newItem.lookahead = 0
			result.add(newItem)
		})
		return result
	}

    buildLRTable(useLookahead: boolean, mergeSimilarStates: boolean): boolean {
		if(!this.isAugmented()) return false
		let result: boolean = true
		this.calculateFirstSets()
		this.calculateFollowSets()
		this.LRTable = new Map()

		let startItem = new item(this.initialSymbol, this.productions.get(this.initialSymbol)!.nthElement(0)!.key, 0, 0, 0)
        let stateCnt = 0
		const initialSet = this.itemClosure(new AVLSet(itemComp, [startItem], itemHash), useLookahead)
        let states: Array<AVLSet<item>> = [initialSet]
        const mapping: AVLMap<AVLSet<item>, number> = new AVLMap(function(a, b){return a.compareTo(b)})
		mapping.set(initialSet, stateCnt++)
		
		let allSymbols = Array.from([...this.nonTerminalSymbols.toArray(), ...this.terminalSymbols.toArray()])

        for (let i = 0; i < states.length; ++i){
			const oldStates = states[i]
			if(!this.LRTable.has(i)) this.LRTable.set(i, new Map())
			let row = this.LRTable.get(i)!
            allSymbols.forEach(symbol => {
				const newStates = this.itemGo(oldStates, symbol, useLookahead)
                if(newStates.size() > 0){
                    if(!mapping.has(newStates)){
                        states.push(newStates)
                        mapping.set(newStates, stateCnt++)
                    }
					const toStateID: number = mapping.get(newStates)!
					row.set(symbol, toStateID)
                }
			})
		}

		if(mergeSimilarStates){
			stateCnt = 0
			let mappingCore: AVLMap<AVLSet<item>, number> = new AVLMap(function(a, b){return a.compareTo(b)})
			let stateTranslator: AVLMap<number, number> = new AVLMap(intComp)
			const newStates: Array<AVLSet<item>> = []
			for (let i = 0; i < states.length; ++i){
				let coreState = this.getCoreItems(states[i])
				if(!mappingCore.has(coreState)){
					mappingCore.set(coreState, stateCnt++)
					newStates.push(states[i])
				}else{
					newStates[mappingCore.get(coreState)!].join(states[i])
				}
				stateTranslator.set(i, mappingCore.get(coreState)!)
			}
			let newTable: Map<number, Map<tokenID | nonTerminal, item | number> > = new Map()
			for (let i = 0; i < states.length; ++i){
				let row = this.LRTable.get(i)!
				let fromStateID = stateTranslator.get(i)!
				if(!newTable.has(fromStateID)) newTable.set(fromStateID, new Map())
				let newRow = newTable.get(fromStateID)!
				row.forEach((toStateID, symbol) => {
					newRow.set(symbol, stateTranslator.get(toStateID as number)!)
				})
			}
			states = newStates
			this.LRTable = newTable
		}

		for (let i = 0; i < stateCnt; ++i){
			const oldStates = states[i]
			let row = this.LRTable!.get(i)!
			oldStates.forEach(item => {
				if(item.end()){
					let args = useLookahead ? new AVLSet(intComp, [item.lookahead]) : this.follow.get(item.LHS)!
					args.forEach(arg => {
						if(row.has(arg))
							result = false
						row.set(arg, item)
					})
				}
			})
		}

		if(!result) this.LRTable = null
		return result
	}
	
	parseStringWithLR(testString: string, useLookahead: boolean, mergeSimilarStates: boolean, callback: ((stackContent: productionText, position: tokenID, action: number|item|null)=>any) | null = null): ParseInfo|null {
		if(!this.buildLRTable(useLookahead, mergeSimilarStates)) return null

		let stack: Array<node | tokenID | number> = [0]
		let nodes: Array<node> = []
		let valid: boolean = true
		
		if(this.FSA == null) return null
		let lexer: Lexer = new Lexer(this.FSA, testString)
		let prevPosition = 0
		let lexemes: Array<string> = []

		while (true) {
			let currentToken: tokenID = lexer.getNextToken()
			if (currentToken === TokenError) lexer.advance()
			if (currentToken != TokenEOF && prevPosition == lexer.position) {
                lexer.advance()
                currentToken = TokenError
			}

			if(valid){
				if(stack.length == 0) break

				while(true){
					let stackContent: productionText = stack.map(c => {
						if(typeof c === "object")
							return c.LHS
						else
							return c
					})
					let top = stack[stack.length - 1]
					let row = this.LRTable!.get(top as number)!
					if(!row.has(currentToken)){
						if(callback && valid) callback(stackContent, currentToken, null)
						valid = false
						break
					}
					let action = row.get(currentToken)!
					if(callback && valid) callback(stackContent, currentToken, action)
					if(typeof action === "number"){ //shift
						stack.push(...[currentToken, action])
						break
					}else if(typeof action === "object"){ //reduce
						let newNode = new node(action.LHS, action.rule)
						for(let i = stack.length - 2*action.rule.RHS.length; i < stack.length; i += 2){
							let c = stack[i]
							if(typeof c === "object"){
								newNode.children.push(c)
							}
						}
						stack.splice(stack.length - 2*action.rule.RHS.length, 2*action.rule.RHS.length)
						stack.push(newNode)
						if(action.LHS === this.initialSymbol){
							nodes.push(newNode) //accepted
							break
						}
						row = this.LRTable!.get(stack[stack.length - 2] as number)!
						if(!row.has(action.LHS)){
							if(callback && valid) callback(stackContent, currentToken, null)
							valid = false
							break
						}
						action = row.get(action.LHS)!
						stack.push(action as number)
					}
				}
			}

			if (currentToken === TokenEOF) break
			lexemes.push(testString.substring(prevPosition, lexer.position));
			prevPosition = lexer.position
		}

		return {
			lexemes: lexemes,
			derivations: nodes,
		}
	}
    // ============ End of LR parser ===============

	// ============ Begin of Earley parser =========
    private createTree(root: item): node {
		let ans = new node(root.LHS, root.rule)
		for(let curr: item|null = root; curr != null && curr.position > 0; curr = curr.prev)
			if(curr.complete)
				ans.children = [this.createTree(curr.complete), ...ans.children]
		return ans
    }

    parseStringWithEarley (testString: string, callback: ((row: Array<item>, position: tokenID)=>any) | null = null): ParseInfo|null {
		if(this.FSA == null) return null
    	let lexer: Lexer = new Lexer(this.FSA, testString)
		let dp: Array<Array<item> > = [[]]
		let dpSet: Array<AVLSet<item> > = [new AVLSet(itemComp)]
		this.productions.get(this.initialSymbol)!.forEach(rule => {
			let newItem = new item(this.initialSymbol, rule, 0, 0, 0)
			dp[0].push(newItem)
			dpSet[0].add(newItem)
		})
		let n: number = 0
		let prevPosition = 0
		let lexemes: Array<string> = []

		let append: (n: number, newItem: item) => boolean = function(n: number, newItem: item): boolean{
			if(!dpSet[n].has(newItem)){
				dp[n].push(newItem)
				dpSet[n].add(newItem)
				return true
			}
			return false
		}

		while (true) {
			let currentToken: tokenID = lexer.getNextToken()
			if (currentToken === TokenError) lexer.advance()
			if (currentToken != TokenEOF && prevPosition == lexer.position) {
                lexer.advance()
                currentToken = TokenError
            }

			if(typeof dp[n] === "undefined"){
				dp[n] = []
				dpSet[n] = new AVLSet(itemComp)
			}
			
			for(let change = true; change; ){ //only used for empty rules
				change = false
				for(let j = 0; j < dp[n].length; ++j){
					let predicted: AVLSet<nonTerminal> = new AVLSet(stringComp)
					let currItem: item = dp[n][j]
					let next: tokenID|nonTerminal = currItem.nextPosition()
					if(currItem.end()){ //completition
						dp[currItem.start].forEach(item => {
							if(item.nextPosition() === currItem.LHS){
								let newItem: item = item.clone()
								++newItem.position
								newItem.prev = item
								newItem.complete = currItem
								change = change || append(n, newItem)
							}
						})
					}else if(typeof next === "number" && this.isTerminal(next)){ //scanner
						if(next === currentToken){
							let newItem: item = currItem.clone()
							++newItem.position
							newItem.prev = currItem
							newItem.complete = null
							if(typeof dp[n + 1] === "undefined"){
								dp[n + 1] = []
								dpSet[n + 1] = new AVLSet(itemComp)
							}
							append(n + 1, newItem)
						}
					}else if(typeof next === "string" && this.isNonTerminal(next)){ //prediction
						if(!predicted.has(next)){
							this.productions.get(next)!.forEach(rule => {
								let newItem: item = new item(next as nonTerminal, rule, n, 0, 0)
								change = change || append(n, newItem)
							})
							predicted.add(next)
						}
					}
				}
			}

			if(callback) callback(dp[n], currentToken)

			if (currentToken === TokenEOF) break
			lexemes.push(testString.substring(prevPosition, lexer.position));
			prevPosition = lexer.position
			n++
		}

		let nodes: Array<node> = []

		dp[n].forEach(currItem =>{
			if(currItem.end() && currItem.start == 0 && currItem.LHS === this.initialSymbol)
				nodes = [...nodes, this.createTree(currItem)]
		})

		return {
			lexemes: lexemes,
			derivations: nodes,
		}
	}
	// ============ End of Earley parser ============

	executeActions(info: ParseInfo, index: number = 0): any {
		let posTerminal: number = 0
		let self = this;
		let lexemes: Array<string> = info.lexemes
		let dfs: (current: node) => any = function(current: node): any{
		    let posChild: number = 0
		    let args: Array<any> = []
		    current.rule.RHS.forEach(c => {
		        if(self.isNonTerminal(c))
		            args.push(dfs(current.children[posChild++]))
		        else
		            args.push(lexemes[posTerminal++])
		    })
		    if(current.rule.callback)
		        return current.rule.callback(args)
		    return null
		}
		if(info.derivations[index])
			return dfs(info.derivations[index])
		return null
	}

	serialize(): CFGJSON {
		const JSONCFG: CFGJSON = {
			name: this.name,
			initialSymbol: this.initialSymbol,
			terminalSymbols: this.terminalSymbols.toArray(),
			nonTerminalSymbols: this.nonTerminalSymbols.toArray(),
			FSA: (this.FSA == null ? null : this.FSA.serialize()),
			productions: this.productions.toArray().map(production => [production[0], production[1].toArray().map(rule => {return {RHS: rule.RHS, callback: (rule.callback == null ? null : rule.callback.toString())}})] as [nonTerminal, Array<ProductionJSON>])
		}

		return JSONCFG
	}

	static deserialize(JSONData: CFGJSON) : CFG | null {
		try {
			const result = new CFG(JSONData.terminalSymbols, JSONData.nonTerminalSymbols, JSONData.initialSymbol, (JSONData.FSA == null ? null : FiniteStateAutomata.deserialize(JSONData.FSA)!))
			result.setName(JSONData.name)
			JSONData.productions.forEach(productionData => {
				const LHS: nonTerminal = productionData[0]
				const rules: Array<ProductionJSON> = productionData[1]
				rules.forEach(JSONrule => {
					result.addRule(LHS, JSONrule.RHS, new Function("return " + JSONrule.callback)())
				})
			})

			return result
		} catch(e) {
            return null
        }
	}

	graph(container: HTMLElement, info: ParseInfo, index: number = 0): Vis.Network | null {
		let nodes = new Vis.DataSet()
		let edges = new Vis.DataSet()

		let posTerminal: number = 0
		let posNode: number = 0
		let self = this;
		let lexemes: Array<string> = info.lexemes
		
		let dfs: (current: node, level: number) => void = function(current: node, level: number): void{
			let posChild: number = 0
			let currNode = posNode
		    current.rule.RHS.forEach(c => {
				posNode++
		        if(self.isNonTerminal(c)){
					nodes.add({id: posNode, label: c, level: level, color: {background: 'white'}})
					edges.add({from: currNode, to: posNode, arrows: 'to'})
		            dfs(current.children[posChild++], level + 1)
				}else{
					nodes.add({id: posNode, label: lexemes[posTerminal++], level: level, color: {background: 'cyan'}})
					edges.add({from: currNode, to: posNode, arrows: 'to'})
				}
			})
			if(current.rule.RHS.length == 0){
				posNode++
				nodes.add({id: posNode, label: 'ε', level: level, color: {background: 'green'}})
				edges.add({from: currNode, to: posNode, arrows: 'to'})
			}
		}
		if(info.derivations[index]){
			nodes.add({id: posNode, label: info.derivations[index].LHS, level: 0, color: {background: 'white'}})
			dfs(info.derivations[index], 1)
		}else{
			return null
		}

		let data = {nodes: nodes, edges: edges}
        let options = {
            edges:{
                smooth:{
                    type: 'cubicBezier',
                    forceDirection: 'vertical',
					roundness: 0.4,
					enabled: false
                },
                color:{
                    inherit: false
                }
            },
            layout:{
                hierarchical: {
                    direction: 'UD'
                }
            },
            physics: false,
            clickToUse: true,
            interaction: {
                navigationButtons: true,
                keyboard: {
                    enabled: true,
                    bindToWindow: false,
                }
            }
		}
		return new Vis.Network(container, data, options)
	}

}

window["CFG"] = CFG
window["item"] = item